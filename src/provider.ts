import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
	LanguageModelToolCallPart,
	LanguageModelDataPart,
} from "vscode";

import type {
	HFModelItem,
	ReasoningDetail,
	ReasoningSummaryDetail,
	ReasoningTextDetail,
	ReasoningConfig,
	OpenAIToolCall,
} from "./types";

import {
	convertTools,
	convertMessages,
	tryParseJSONObject,
	validateRequest,
	parseModelId,
	createRetryConfig,
	executeWithRetry,
	shortHash,
} from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { prepareTokenCount } from "./provideToken";
import axios from "axios";
import { Readable } from "stream";

// REDUCED LIMIT to prevent "Budget Exceeded" crash
const MAX_TOOLS_PER_REQUEST = 100;

export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	private readonly _toolCallBuffers: Map<string, {
        toolCall: OpenAIToolCall;
    }> = new Map();
	private _completedToolCallIndices = new Set<number>();
	private _hasEmittedAssistantText = false;
	private _emittedBeginToolCallsHint = false;
	private _textToolActive: undefined | { name?: string; index?: number; argBuffer: string; emitted?: boolean };
	private _emittedTextToolCallKeys = new Set<string>();
	private _emittedTextToolCallIds = new Set<string>();
	private _xmlThinkActive = false;
	private _xmlThinkDetectionAttempted = false;
	private _currentThinkingId: string | null = null;
	private _currentResponseReasoningDetails: ReasoningDetail[] = [];
	private _lastRequestTime: number | null = null;
	private _reasoningTextBuffer = "";

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
		console.log(`[OAI Provider] Start request for model: ${model.id}`);

		// Reset state
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
		this._currentResponseReasoningDetails = [];
		this._reasoningTextBuffer = "";

		const config = vscode.workspace.getConfiguration();

		// 1. Handle Delay
		const delayMs = config.get<number>("oaicopilot.delay", 0);
		if (delayMs > 0 && this._lastRequestTime !== null) {
			const elapsed = Date.now() - this._lastRequestTime;
			if (elapsed < delayMs) {
				await new Promise((resolve) => setTimeout(resolve, delayMs - elapsed));
			}
		}

		let requestBody: Record<string, unknown> | undefined;

		// wrapper to catch progress errors
		const trackingProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					// This often happens if the renderer crashed previously
					console.error("[OAI Provider] Progress report failed:", e);
				}
			},
		};

		try {
			// 2. SAFETY CHECK: Limit Tools to prevent "No lowest priority node" crash
			let safeOptions = { ...options };
			if (safeOptions.tools && safeOptions.tools.length > MAX_TOOLS_PER_REQUEST) {
				console.warn(`[OAI Provider] Too many tools (${safeOptions.tools.length}). Truncating to ${MAX_TOOLS_PER_REQUEST}.`);
				safeOptions.tools = safeOptions.tools.slice(0, MAX_TOOLS_PER_REQUEST);
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

			// Use safeOptions (with truncated tools)
			requestBody = this.prepareRequestBody(requestBody, um, safeOptions);

			const BASE_URL = um?.baseUrl || config.get<string>("oaicopilot.baseUrl", "");
			if (!BASE_URL || !BASE_URL.startsWith("http")) throw new Error(`Invalid base URL.`);

			const retryConfig = createRetryConfig();
			const defaultHeaders: Record<string, string> = {
				Authorization: `Bearer ${modelApiKey}`,
				"Content-Type": "application/json",
				"User-Agent": this.userAgent,
			};
			const requestHeaders = um?.headers ? { ...defaultHeaders, ...um.headers } : defaultHeaders;

			const proxyUrl = config.get<string>("oaicopilot.proxy", "");
			let axiosProxy: any = false;
			if (proxyUrl) {
				try {
					const parsedUrl = new URL(proxyUrl);
					axiosProxy = {
						protocol: parsedUrl.protocol.replace(':', ''),
						host: parsedUrl.hostname,
						port: parsedUrl.port ? parseInt(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)
					};
					if (parsedUrl.username || parsedUrl.password) {
						axiosProxy.auth = { username: parsedUrl.username, password: parsedUrl.password };
					}
				} catch (e) {
					console.error("Invalid proxy URL", e);
				}
			}

			// Execute Request
			const response = await executeWithRetry(
				async () => {
					const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
					const res = await axios.post(url, requestBody, {
						headers: requestHeaders,
						responseType: "stream",
						proxy: axiosProxy,
						validateStatus: () => true,
						rejectUnauthorized: false,
					} as any);

					if (res.status < 200 || res.status >= 300) {
						const stream = res.data;
						const chunks: Buffer[] = [];
						for await (const chunk of stream) chunks.push(Buffer.from(chunk));
						const errorText = Buffer.concat(chunks).toString("utf-8");
						throw new Error(`API error: [${res.status}] ${res.statusText} ${errorText}`);
					}
					return { body: Readable.toWeb(res.data) as ReadableStream<Uint8Array>, ok: true };
				},
				retryConfig,
				token
			);

			if (!response.body) throw new Error("No response body");
			await this.processStreamingResponse(response.body, trackingProgress, token);

		} catch (err) {
			console.error("[OAI Provider] Chat request failed", err);
			throw err;
		} finally {
			this._lastRequestTime = Date.now();
			console.log("[OAI Provider] Request finished");
		}
	}

	private prepareRequestBody(rb: Record<string, unknown>, um: HFModelItem | undefined, options: ProvideLanguageModelChatResponseOptions) {
		const oTemperature = options.modelOptions?.temperature ?? 0;
		rb.temperature = um?.temperature ?? oTemperature;
		const oTopP = options.modelOptions?.top_p ?? 1;
		rb.top_p = um?.top_p ?? oTopP;

		if (um?.max_tokens) rb.max_tokens = um.max_tokens;
		if (um?.max_completion_tokens) rb.max_completion_tokens = um.max_completion_tokens;
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

		// Use the possibly-truncated tools from options
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

	// ... (Keep existing ensureApiKey) ...
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
						await this.flushToolCallBuffers(progress);
						await this.flushActiveTextToolCall(progress);
						await this.flushReasoningBuffer(progress);
						this.closeActiveThinking(progress);
						return;
					}
					try {
						await this.processDelta(JSON.parse(data), progress);
					} catch (e) { }
				}
			}
		} finally {
			this.closeActiveThinking(progress);
			reader.releaseLock();
			// Clean up
			this._toolCallBuffers.clear();
			this._currentThinkingId = null;
			this._reasoningTextBuffer = "";
		}
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
				(deltaObj as Record<string, unknown> | undefined)?.reasoning_content ??
				(deltaObj as Record<string, unknown> | undefined)?.reasoning;

			const maybeReasoningDetails =
				(deltaObj as Record<string, unknown>)?.reasoning_details ??
				(choice as Record<string, unknown>)?.reasoning_details;

			if (maybeReasoningDetails && Array.isArray(maybeReasoningDetails) && maybeReasoningDetails.length > 0) {
				const details: Array<ReasoningDetail> = maybeReasoningDetails as Array<ReasoningDetail>;
				const sortedDetails = details.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

				for (const detail of sortedDetails) {
					this._currentResponseReasoningDetails.push({ ...detail });

					let text = "";
					let signature: string | null = null;
					let isSimpleText = false;

					if (detail.type === "reasoning.summary") {
						text = (detail as ReasoningSummaryDetail).summary;
					} else if (detail.type === "reasoning.text") {
						text = (detail as ReasoningTextDetail).text;
						if ((detail as ReasoningTextDetail).signature) {
							signature = (detail as ReasoningTextDetail).signature || null;
						}
						isSimpleText = true;
					} else if (detail.type === "reasoning.encrypted") {
						text = "[REDACTED]";
						if ((detail as any).data) {
							signature = (detail as any).data;
						}
					} else {
						text = JSON.stringify(detail);
					}

					// Coalescing Logic:
					// If it's simple text without a signature, buffer it.
					if (isSimpleText && !signature) {
						this._reasoningTextBuffer += text;
						// Flush if buffer gets too large to keep UI responsive
						if (this._reasoningTextBuffer.length > 4000) {
							await this.flushReasoningBuffer(progress);
							emitted = true;
						}
					} else {
						// It has a signature or is a special type.
						// 1. Flush any pending buffer first.
						if (this._reasoningTextBuffer.length > 0) {
							await this.flushReasoningBuffer(progress);
							emitted = true;
						}

						// 2. Emit this chunk immediately with its metadata/signature.
						if (text || signature) {
							if (!this._currentThinkingId) this._currentThinkingId = this.generateThinkingId();
							const metadata: Record<string, any> = { format: detail.format, type: detail.type, index: detail.index };

							// IMPORTANT: Include signature in metadata so it can be round-tripped in history.
							if (signature) {
								metadata.signature = signature;
							}

							progress.report(new vscode.LanguageModelThinkingPart(text, this._currentThinkingId, metadata));
							emitted = true;
						}
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
			}

			if (xmlRes.remainingText.length > 0) {
				const hasVisibleContent = xmlRes.remainingText.trim().length > 0;
				if (hasVisibleContent && this._currentThinkingId) {
					try {
						progress.report(new vscode.LanguageModelThinkingPart("", this._currentThinkingId));
					} catch (e) { } finally {
						this._currentThinkingId = null;
					}
				}
				const res = this.processTextContent(xmlRes.remainingText, progress);
				if (res.emittedText) this._hasEmittedAssistantText = true;
				if (res.emittedAny) emitted = true;
			}
		}

		if (deltaObj?.tool_calls) {
			const { tool_calls } = deltaObj;
			if (tool_calls) {
				for (const tc of tool_calls as any[]) {
					if (!tc) continue;
					const { id, function: func, "x-provider": providerFields } = tc;
					let buf = this._toolCallBuffers.get(id ?? "");
					if (!buf) {
						buf = { toolCall: { id: id ?? "", type: "function", function: { name: "", arguments: "" } } };
						if (id) {
							this._toolCallBuffers.set(id, buf);
						}
					}
					if (func?.name) buf.toolCall.function.name += func.name;
					if (func?.arguments) buf.toolCall.function.arguments += func.arguments;

					if (providerFields?.thought) {
						progress.report(new vscode.LanguageModelToolCallPart(id ?? "", id ?? "", { thought: providerFields.thought }));
						emitted = true;
					}
				}
			}
		}



		const finish = (choice.finish_reason as string | undefined) ?? undefined;
		if (finish === "tool_calls" || finish === "stop") {
			await this.flushToolCallBuffers(progress);
		}
		return emitted;
	}

	private processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean; remainingText: string } {
		const THINK_START = "<think>";
		const THINK_END = "</think>";
		let data = input;
		let emittedAny = false;
		let remainingText = "";

        // Optimization for simple text
        if (this._xmlThinkDetectionAttempted && !this._xmlThinkActive) {
            return { emittedAny: false, remainingText: input };
        }

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
                    this._xmlThinkDetectionAttempted = true;
					remainingText += data;
					data = "";
					break;
				}

				remainingText += data.slice(0, startIdx);
				this._xmlThinkActive = true;
				this._currentThinkingId = this.generateThinkingId();
				data = data.slice(startIdx + THINK_START.length);
				continue;
			}

			const endIdx = data.indexOf(THINK_END);
			if (endIdx === -1) {
                if(!this._currentThinkingId) this._currentThinkingId = this.generateThinkingId();
				progress.report(new vscode.LanguageModelThinkingPart(data, this._currentThinkingId));
				emittedAny = true;
				data = "";
				break;
			}

			const content = data.slice(0, endIdx);
            if(!this._currentThinkingId) this._currentThinkingId = this.generateThinkingId();
			progress.report(new vscode.LanguageModelThinkingPart(content, this._currentThinkingId));
			emittedAny = true;

			this._xmlThinkActive = false;
			this.closeActiveThinking(progress);
			data = data.slice(endIdx + THINK_END.length);
		}
		return { emittedAny, remainingText };
	}
	private generateThinkingId(): string {
		return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

	private tryEmitBufferedToolCall(
		key: string,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		isLast: boolean
	) {
		const buf = this._toolCallBuffers.get(key);
		if (!buf || !buf.toolCall.function.name) {
			return;
		}

		const canParseResult = tryParseJSONObject(buf.toolCall.function.arguments);
		if (!canParseResult.ok && !isLast) {
			// If we can't parse it, and it's not the last chunk, wait for more data.
			return;
		}

		const id = buf.toolCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		const parameters = canParseResult.ok ? canParseResult.value : buf.toolCall.function.arguments;

		if (canParseResult.ok) {
			const canonical = JSON.stringify(parameters);
			const toolKey = `${buf.toolCall.function.name}:${canonical}`;
			if (this._emittedTextToolCallKeys.has(toolKey)) {
				this._toolCallBuffers.delete(key);
				return;
			}
			this._emittedTextToolCallKeys.add(toolKey);
		}

		// Emit the tool call with a clean ID.
		progress.report(new vscode.LanguageModelToolCallPart(id, buf.toolCall.function.name, typeof parameters === 'string' ? {} : parameters));

		this._toolCallBuffers.delete(key);
	}

	private flushToolCallBuffers(progress: vscode.Progress<vscode.LanguageModelResponsePart2>) {
		if (this._toolCallBuffers.size === 0) return;

		for (const key of this._toolCallBuffers.keys()) {
			this.tryEmitBufferedToolCall(key, progress, true);
		}
	}

	private async flushReasoningBuffer(progress: Progress<LanguageModelResponsePart2>): Promise<void> {
		if (this._reasoningTextBuffer.length > 0) {
			if (!this._currentThinkingId) this._currentThinkingId = this.generateThinkingId();
			// Emit buffered text as a simple reasoning.text block
			progress.report(new vscode.LanguageModelThinkingPart(this._reasoningTextBuffer, this._currentThinkingId, { type: "reasoning.text" }));
			this._reasoningTextBuffer = "";
		}
	}

	private closeActiveThinking(progress: Progress<LanguageModelResponsePart2>) {
		if (this._currentThinkingId) {
			try {
				progress.report(new vscode.LanguageModelThinkingPart("", this._currentThinkingId));
			} catch (e) {
				// Ignore errors if progress is already closed
			} finally {
				this._currentThinkingId = null;
			}
		}
	}
}