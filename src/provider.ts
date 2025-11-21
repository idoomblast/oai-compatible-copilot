import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type {
	HFModelItem,
	ReasoningDetail,
	ReasoningSummaryDetail,
	ReasoningTextDetail,
	ReasoningConfig,
} from "./types";

import {
	convertTools,
	convertMessages,
	tryParseJSONObject,
	validateRequest,
	parseModelId,
	createRetryConfig,
	executeWithRetry,
} from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { prepareTokenCount } from "./provideToken";

const MAX_TOOLS_PER_REQUEST = 128;

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/**
		 * Buffer for assembling streamed tool calls by index.
		 * UPDATED: Added thoughtSignature to the buffer structure.
		 */
	private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string; thoughtSignature?: string }> = new Map();

	/** Indices for which a tool call has been fully emitted. */
	private _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	private _hasEmittedAssistantText = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	private _emittedBeginToolCallsHint = false;

	private _textToolActive:
		| undefined
		| {
			name?: string;
			index?: number;
			argBuffer: string;
			emitted?: boolean;
		};
	private _emittedTextToolCallKeys = new Set<string>();
	private _emittedTextToolCallIds = new Set<string>();

	// XML think block parsing state
	private _xmlThinkActive = false;
	private _xmlThinkDetectionAttempted = false;

	// Thinking content state management
	private _currentThinkingId: string | null = null;

	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	/**
		 * Store Gemini-3-Pro thought signatures mapped by Tool Call ID.
		 * Using a Map ensures we inject the correct signature for the correct tool call.
		 */
	private _geminiThoughtSignatures: Map<string, string> = new Map();

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly userAgent: string
	) { }

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return prepareLanguageModelChatInformation(
			{ silent: options.silent ?? false },
			_token,
			this.secrets,
			this.userAgent
		);
	}

	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		return prepareTokenCount(model, text, _token);
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		this._toolCallBuffers.clear();
		this._completedToolCallIndices.clear();
		this._hasEmittedAssistantText = false;
		this._emittedBeginToolCallsHint = false;
		this._textToolActive = undefined;
		this._emittedTextToolCallKeys.clear();
		this._emittedTextToolCallIds.clear();
		this._xmlThinkActive = false;
		this._xmlThinkDetectionAttempted = false;
		this._currentThinkingId = null;

		const config = vscode.workspace.getConfiguration();
		const delayMs = config.get<number>("oaicopilot.delay", 0);

		if (delayMs > 0 && this._lastRequestTime !== null) {
			const elapsed = Date.now() - this._lastRequestTime;
			if (elapsed < delayMs) {
				const remainingDelay = delayMs - elapsed;
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(() => {
						clearTimeout(timeout);
						resolve();
					}, remainingDelay);
				});
			}
		}

		let requestBody: Record<string, unknown> | undefined;
		const trackingProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[OAI Compatible Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		try {
			if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
				throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
			}

			const openaiMessages = convertMessages(messages);
			validateRequest(messages);

			const userModels = config.get<HFModelItem[]>("oaicopilot.models", []);
			const parsedModelId = parseModelId(model.id);

			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
			}

			const provider = um?.owned_by;
			const useGenericKey = !um?.baseUrl;
			const modelApiKey = await this.ensureApiKey(useGenericKey, provider);
			if (!modelApiKey) {
				throw new Error("OAI Compatible API key not found");
			}

			requestBody = {
				model: parsedModelId.baseId,
				messages: openaiMessages,
				stream: true,
				stream_options: { include_usage: true },
			};
			requestBody = this.prepareRequestBody(requestBody, um, options);

			// ---------------------------------------------------------
			// IMPROVED GEMINI-3-PRO THOUGHT SIGNATURE INJECTION
			// ---------------------------------------------------------
			if (parsedModelId.baseId.includes('gemini-3') || um?.family?.includes('gemini-3') || um?.id.includes('gemini-3')) {
				for (const msg of openaiMessages) {
					// Cari message dari assistant yang memiliki tool_calls
					if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
						for (const tc of msg.tool_calls) {
							// Ambil signature yang tersimpan di Map berdasarkan ID
							const capturedSig = this._geminiThoughtSignatures.get(tc.id);

							if (capturedSig) {
								// 1. Injeksi ke provider_specific_fields (Standar OpenRouter/LiteLLM)
								// Pastikan object ada
								if (!(tc as any).provider_specific_fields) {
									(tc as any).provider_specific_fields = {};
								}
								(tc as any).provider_specific_fields.thought_signature = capturedSig;

								// 2. (Opsional) Injeksi ke extra_content jika proxy Anda spesifik butuh ini
								// Hapus bagian ini jika Anda yakin menggunakan OpenRouter standar
								if (!(tc as any).extra_content) {
									(tc as any).extra_content = {};
								}
								if (!(tc as any).extra_content.google) {
									(tc as any).extra_content.google = {};
								}
								(tc as any).extra_content.google.thought_signature = capturedSig;

								console.log(`[Gemini-3-Pro] Injected signature for ${tc.id} into provider_specific_fields`);
							}
						}
					}
				}
			}

			// ---------------------------------------------------------

			if (Array.isArray(requestBody.messages)) {
				const filteredMessages = requestBody.messages.filter(
					(msg: any) => msg.role === "assistant" || msg.role === "model"
				);
				const logBody = { ...requestBody, messages: filteredMessages };
				console.log("[OAI Compatible Model Provider] RequestBody assistant debug:", JSON.stringify(logBody));
			}

			const BASE_URL = um?.baseUrl || config.get<string>("oaicopilot.baseUrl", "");
			if (!BASE_URL || !BASE_URL.startsWith("http")) {
				throw new Error(`Invalid base URL configuration.`);
			}

			const retryConfig = createRetryConfig();

			const defaultHeaders: Record<string, string> = {
				Authorization: `Bearer ${modelApiKey}`,
				"Content-Type": "application/json",
				"User-Agent": this.userAgent,
			};

			const requestHeaders = um?.headers ? { ...defaultHeaders, ...um.headers } : defaultHeaders;

			const response = await executeWithRetry(
				async () => {
					const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[OAI Compatible Model Provider] API error", errorText);
						throw new Error(
							`API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`
						);
					}

					return res;
				},
				retryConfig,
				token
			);

			if (!response.body) {
				throw new Error("No response body from API");
			}
			await this.processStreamingResponse(response.body, trackingProgress, token);
		} catch (err) {
			console.error("[OAI Compatible Model Provider] Chat request failed", err);
			throw err;
		} finally {
			this._lastRequestTime = Date.now();
		}
	}

	private prepareRequestBody(
		rb: Record<string, unknown>,
		um: HFModelItem | undefined,
		options: ProvideLanguageModelChatResponseOptions
	) {
		const oTemperature = options.modelOptions?.temperature ?? 0;
		const temperature = um?.temperature ?? oTemperature;
		rb.temperature = temperature;

		const oTopP = options.modelOptions?.top_p ?? 1;
		const topP = um?.top_p ?? oTopP;
		rb.top_p = topP;

		if (um && um.temperature === null) delete rb.temperature;
		if (um && um.top_p === null) delete rb.top_p;

		if (um?.max_tokens !== undefined) rb.max_tokens = um.max_tokens;
		if (um?.max_completion_tokens !== undefined) rb.max_completion_tokens = um.max_completion_tokens;
		if (um?.reasoning_effort !== undefined) rb.reasoning_effort = um.reasoning_effort;

		const enableThinking = um?.enable_thinking;
		if (enableThinking !== undefined) {
			rb.enable_thinking = enableThinking;
			if (um?.thinking_budget !== undefined) {
				rb.thinking_budget = um.thinking_budget;
			}
		}

		if (um?.thinking?.type !== undefined) {
			rb.thinking = { type: um.thinking.type };
		}

		if (um?.reasoning !== undefined) {
			const reasoningConfig: ReasoningConfig = um.reasoning as ReasoningConfig;
			if (reasoningConfig.enabled !== false) {
				const reasoningObj: Record<string, unknown> = {};
				const effort = reasoningConfig.effort;
				const maxTokensReasoning = reasoningConfig.max_tokens || 2000;
				if (effort && effort !== "auto") {
					reasoningObj.effort = effort;
				} else {
					reasoningObj.max_tokens = maxTokensReasoning;
				}
				if (reasoningConfig.exclude !== undefined) {
					reasoningObj.exclude = reasoningConfig.exclude;
				}
				rb.reasoning = reasoningObj;
			}
		}

		if (options.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
				rb.stop = mo.stop;
			}
		}

		const toolConfig = convertTools(options);
		if (toolConfig.tools) rb.tools = toolConfig.tools;
		if (toolConfig.tool_choice) rb.tool_choice = toolConfig.tool_choice;

		if (um?.top_k !== undefined) rb.top_k = um.top_k;
		if (um?.min_p !== undefined) rb.min_p = um.min_p;
		if (um?.frequency_penalty !== undefined) rb.frequency_penalty = um.frequency_penalty;
		if (um?.presence_penalty !== undefined) rb.presence_penalty = um.presence_penalty;
		if (um?.repetition_penalty !== undefined) rb.repetition_penalty = um.repetition_penalty;

		if (um?.extra && typeof um.extra === "object") {
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) rb[key] = value;
			}
		}

		return rb;
	}

	private async ensureApiKey(useGenericKey: boolean, provider?: string): Promise<string | undefined> {
		let apiKey: string | undefined;
		if (provider && provider.trim() !== "") {
			const normalizedProvider = provider.toLowerCase();
			const providerKey = `oaicopilot.apiKey.${normalizedProvider}`;
			apiKey = await this.secrets.get(providerKey);

			if (!apiKey && !useGenericKey) {
				const entered = await vscode.window.showInputBox({
					title: `API Key for ${normalizedProvider}`,
					prompt: `Enter API key for ${normalizedProvider}`,
					ignoreFocusOut: true,
					password: true,
				});
				if (entered && entered.trim()) {
					apiKey = entered.trim();
					await this.secrets.store(providerKey, apiKey);
				}
			}
		}

		if (!apiKey) {
			apiKey = await this.secrets.get("oaicopilot.apiKey");
		}

		if (!apiKey && useGenericKey) {
			const entered = await vscode.window.showInputBox({
				title: "API Key",
				prompt: "Enter API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("oaicopilot.apiKey", apiKey);
			}
		}
		return apiKey;
	}

	private async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						await this.flushToolCallBuffers(progress, false);
						await this.flushActiveTextToolCall(progress);
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						await this.processDelta(parsed, progress);
					} catch {
						// ignore malformed
					}
				}
			}
		} finally {
			reader.releaseLock();
			this._toolCallBuffers.clear();
			this._completedToolCallIndices.clear();
			this._hasEmittedAssistantText = false;
			this._emittedBeginToolCallsHint = false;
			this._textToolActive = undefined;
			this._emittedTextToolCallKeys.clear();
			this._xmlThinkActive = false;
			this._xmlThinkDetectionAttempted = false;
			this._currentThinkingId = null;
		}
	}

	private generateThinkingId(): string {
		return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	private async processDelta(
		delta: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<boolean> {
		let emitted = false;
		const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) return false;

		const deltaObj = choice.delta as Record<string, unknown> | undefined;

		// Process thinking content
		try {
			let maybeThinking =
				(choice as Record<string, unknown> | undefined)?.thinking ??
				(deltaObj as Record<string, unknown> | undefined)?.thinking ??
				(deltaObj as Record<string, unknown> | undefined)?.reasoning_content;

			const maybeReasoningDetails =
				(deltaObj as Record<string, unknown>)?.reasoning_details ??
				(choice as Record<string, unknown>)?.reasoning_details;

			if (maybeReasoningDetails && Array.isArray(maybeReasoningDetails) && maybeReasoningDetails.length > 0) {
				const details: Array<ReasoningDetail> = maybeReasoningDetails as Array<ReasoningDetail>;
				const sortedDetails = details.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

				for (const detail of sortedDetails) {
					let extractedText = "";
					if (detail.type === "reasoning.summary") {
						extractedText = (detail as ReasoningSummaryDetail).summary;
					} else if (detail.type === "reasoning.text") {
						extractedText = (detail as ReasoningTextDetail).text;
					} else if (detail.type === "reasoning.encrypted") {
						extractedText = "[REDACTED]";
					} else {
						extractedText = JSON.stringify(detail);
					}

					if (extractedText) {
						if (!this._currentThinkingId) this._currentThinkingId = this.generateThinkingId();
						const metadata = { format: detail.format, type: detail.type, index: detail.index };
						progress.report(new vscode.LanguageModelThinkingPart(extractedText, this._currentThinkingId, metadata));
						emitted = true;
					}
				}
				maybeThinking = null;
			}

			if (maybeThinking !== undefined && maybeThinking !== null) {
				let text = "";
				let metadata: Record<string, unknown> | undefined;
				if (maybeThinking && typeof maybeThinking === "object") {
					const mt = maybeThinking as Record<string, unknown>;
					text = typeof mt["text"] === "string" ? (mt["text"] as string) : JSON.stringify(mt);
					metadata = mt["metadata"] ? (mt["metadata"] as Record<string, unknown>) : undefined;
				} else if (typeof maybeThinking === "string") {
					text = maybeThinking;
				}
				if (text) {
					if (!this._currentThinkingId) this._currentThinkingId = this.generateThinkingId();
					progress.report(new vscode.LanguageModelThinkingPart(text, this._currentThinkingId, metadata));
					emitted = true;
				}
			}
		} catch (e) {
			console.warn("[OAI Compatible Model Provider] Failed to process thinking:", e);
		}

		// Process Text Content
		if (deltaObj?.content) {
			const content = String(deltaObj.content);
			const xmlRes = this.processXmlThinkBlocks(content, progress);
			if (xmlRes.emittedAny) {
				emitted = true;
			} else {
				const hasVisibleContent = content.trim().length > 0;
				if (hasVisibleContent && this._currentThinkingId) {
					try {
						progress.report(new vscode.LanguageModelThinkingPart("", this._currentThinkingId));
					} catch (e) { } finally {
						this._currentThinkingId = null;
					}
				}
				const res = this.processTextContent(content, progress);
				if (res.emittedText) this._hasEmittedAssistantText = true;
				if (res.emittedAny) emitted = true;
			}
		}

		// Process Tool Calls
		if (deltaObj?.tool_calls) {
			const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

			if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._emittedBeginToolCallsHint = true;
			}

			for (const tc of toolCalls) {
				const idx = (tc.index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) continue;

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };

				if (tc.id && typeof tc.id === "string") buf.id = tc.id as string;
				const func = tc.function as Record<string, unknown> | undefined;
				if (func?.name && typeof func.name === "string") buf.name = func.name as string;
				if (typeof func?.arguments === "string") buf.args += func.arguments as string;

				// ---------------------------------------------------------
				// CAPTURE THOUGHT SIGNATURE from stream
				// ---------------------------------------------------------
				const providerFields = tc.provider_specific_fields as Record<string, unknown> | undefined;
				if (providerFields && typeof providerFields.thought_signature === "string") {
					buf.thoughtSignature = providerFields.thought_signature;
					// Also save immediately if we have ID, in case it's split
					if (buf.id) {
						this._geminiThoughtSignatures.set(buf.id, buf.thoughtSignature);
					}
				}
				// ---------------------------------------------------------

				this._toolCallBuffers.set(idx, buf);
				await this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		const finish = (choice.finish_reason as string | undefined) ?? undefined;
		if (finish === "tool_calls" || finish === "stop") {
			await this.flushToolCallBuffers(progress, true);
		}
		return emitted;
	}

	private processTextContent(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedText: boolean; emittedAny: boolean } {
		let emittedText = false;
		let emittedAny = false;
		const textToEmit = input;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedText = true;
			emittedAny = true;
		}
		return { emittedText, emittedAny };
	}

	private emitTextToolCallIfValid(
		progress: Progress<LanguageModelResponsePart2>,
		call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
		argText: string
	): boolean {
		const name = call.name ?? "unknown_tool";
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) return false;

		const canonical = JSON.stringify(parsed.value);
		const key = `${name}:${canonical}`;
		if (typeof call.index === "number") {
			const idKey = `${name}:${call.index}`;
			if (this._emittedTextToolCallIds.has(idKey)) return false;
			this._emittedTextToolCallIds.add(idKey);
		} else if (this._emittedTextToolCallKeys.has(key)) {
			return false;
		}
		this._emittedTextToolCallKeys.add(key);
		const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
		progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
		return true;
	}

	private async flushActiveTextToolCall(progress: Progress<LanguageModelResponsePart2>): Promise<void> {
		if (!this._textToolActive) return;
		const argText = this._textToolActive.argBuffer;
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) return;
		this.emitTextToolCallIfValid(progress, this._textToolActive, argText);
		this._textToolActive = undefined;
	}

	private async tryEmitBufferedToolCall(index: number, progress: Progress<LanguageModelResponsePart2>): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf || !buf.name) return;

		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) return;

		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;

		// Save signature permanently if present in buffer (and not already saved)
		if (buf.thoughtSignature) {
			this._geminiThoughtSignatures.set(id, buf.thoughtSignature);
		}

		const parameters = canParse.value;
		try {
			const canonical = JSON.stringify(parameters);
			this._emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
		} catch { }

		progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	private async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) return;

		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			const parsed = tryParseJSONObject(buf.args);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[OAI Compatible Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				continue;
			}

			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";

			// Save signature permanently during flush
			if (buf.thoughtSignature) {
				this._geminiThoughtSignatures.set(id, buf.thoughtSignature);
			}

			try {
				const canonical = JSON.stringify(parsed.value);
				this._emittedTextToolCallKeys.add(`${name}:${canonical}`);
			} catch { }

			progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
		}
	}

	private processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		if (this._xmlThinkDetectionAttempted && !this._xmlThinkActive) return { emittedAny: false };

		const THINK_START = "<think>";
		const THINK_END = "</think>";
		let data = input;
		let emittedAny = false;

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
					this._xmlThinkDetectionAttempted = true;
					data = "";
					break;
				}
				this._xmlThinkActive = true;
				this._currentThinkingId = this.generateThinkingId();
				data = data.slice(startIdx + THINK_START.length);
				continue;
			}

			const endIdx = data.indexOf(THINK_END);
			if (endIdx === -1) {
				const thinkContent = data.trim();
				if (thinkContent) {
					progress.report(new vscode.LanguageModelThinkingPart(thinkContent, this._currentThinkingId || undefined));
					emittedAny = true;
				}
				data = "";
				break;
			}

			const thinkContent = data.slice(0, endIdx);
			if (thinkContent) {
				progress.report(new vscode.LanguageModelThinkingPart(thinkContent, this._currentThinkingId || undefined));
				emittedAny = true;
			}

			this._xmlThinkActive = false;
			this._currentThinkingId = null;
			data = data.slice(endIdx + THINK_END.length);
		}

		return { emittedAny };
	}

	getGeminiThoughtSignatures(): Map<string, string> {
		return new Map(this._geminiThoughtSignatures);
	}

	resetGeminiThoughtSignatures(): void {
		this._geminiThoughtSignatures.clear();
	}
}