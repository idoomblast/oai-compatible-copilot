# Refactoring Report: Final Solution for Thought Signature Handling

**Date:** 2025-11-23
**Branch:** `feat-gemini-3`

## 1. Objective

The primary goal was to resolve a critical token budget error (`No lowest priority node found`) that occurred during chat history summarization. The error was caused by embedding long "thought signatures" into the `tool_call_id`, which inflated the token count and broke the host's internal budgeting mechanism.

## 2. Problem Analysis: Why Previous Attempts Failed

Two previous refactoring attempts failed to solve the root cause:

1.  **In-Memory Map (`_toolSignatures`)**: This approach stripped the signature before the API call and re-attached it after. While it cleaned the ID for the API, the modified ID was still reported to the VS Code host, causing the same token budget error.
2.  **Hashing and Caching (`_signatureCache`)**: This attempt replaced the long signature with a short hash in the `tool_call_id` and stored the full signature in `workspaceState`. This reduced the ID length but did not eliminate the core problem: **any manipulation of the `tool_call_id` corrupts the chat history from the host's perspective**, leading to summarization failures.

The core insight was that the `tool_call_id` must remain pristine throughout the entire lifecycle of the chat response. The signature metadata needed to be stored and transmitted in a way that did not interfere with the primary chat message structure.

## 3. The Final Solution: Decoupling Signatures with `LanguageModelDataPart`

The successful solution was to completely decouple the signature from the tool call ID by using the proposed `vscode.LanguageModelDataPart` API. This API allows for emitting arbitrary structured data as a distinct part of the language model's response, without altering other parts.

### How It Works:

1.  **Clean Tool Call Emission**: The `LanguageModelToolCallPart` is now always emitted with its original, clean `id` as provided by the language model. No modifications are ever made to it.
2.  **Separate Metadata Part**: Immediately after a tool call is emitted, if a `_currentReasoningSignature` exists from the model's thinking process, it is emitted in a separate `vscode.LanguageModelDataPart`.
3.  **Linking**: This new data part contains a JSON object that links the signature to the tool call it belongs to, without altering the tool call itself.
    *   **MIME Type**: A custom MIME type, `application/vnd.copilot.signature`, is used to identify this metadata.
    *   **Payload**: The data part contains `{ "signatureFor": "...", "signature": "..." }`, where `signatureFor` holds the clean `tool_call_id`.
4.  **State Management**: The `_currentReasoningSignature` is consumed (set to `null`) after being used to ensure it is only associated with a single tool call.

### Key Implementation Changes (`src/provider.ts`):

-   **Removed ID Manipulation**: All logic for splitting, hashing, caching, and re-combining `tool_call_id`s was completely removed from `provideLanguageModelChatResponse`. The `_signatureCache` was also deleted.
-   **Updated `tryEmitBufferedToolCall`**: This function was refactored to:
    1.  Emit a `new vscode.LanguageModelToolCallPart(...)` with the clean `id`.
    2.  Check if `this._currentReasoningSignature` is present.
    3.  If it is, emit a `vscode.LanguageModelDataPart.json(...)` with the signature payload and custom MIME type.
    4.  Set `this._currentReasoningSignature = null`.

## 4. Outcome

This approach is robust and correctly uses the VS Code language model APIs as intended. By treating the signature as separate, out-of-band metadata, we no longer interfere with the chat history's core structure. The token budget errors are resolved, and the reasoning data is preserved reliably across chat turns.

---

## 5. UPDATE: FAILED

Despite the theoretical correctness of this approach, it still failed to resolve the underlying issue. The same token budget error occurred, indicating the problem is more deeply rooted in how the VS Code chat host calculates budget and performs summarization, even when using `LanguageModelDataPart`.

The core problem remains elusive, but it is clear that the presence of any extra data, even when separated into a `DataPart`, contributes to the budget calculation in a way that leads to this crash.

### Error Log:

```
2025-11-23 22:09:45.306 [debug] AgentIntent: rendering with budget=-422 (baseBudget: 1, toolTokens: 497), summarizationEnabled=true
2025-11-23 22:09:45.318 [debug] [Agent] budget exceeded, triggering summarization (No lowest priority node found (path: Mve -> 1) (at tsx element Tv))
2025-11-23 22:09:45.333 [error] Error: No lowest priority node found (path: Mve -> 1) (at tsx element Tv)
    at b3e (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:3:3790)
    at b3e (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:3:3906)
    at n.removeLowestPriorityChild (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1:9652)
    at Lt._getFinalElementTree (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:4:30807)
    at Lt.renderRaw (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:4:29351)
    at Lt.render (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:4:29014)
    at Lt.render (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1113:31627)
    at Tl (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1115:714)
    at Tv.getOrCreateGlobalAgentContextContent (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1360:4482)
    at Tv.getOrCreateGlobalAgentContext (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1360:3998)
    at Tv.render (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1360:1505)
    at uwt (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:6:3706)
    at c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:4:28184
    at async Promise.all (index 0)
    at Lt._processPromptPieces (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:4:28095)
    at Lt.renderRaw (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:4:29130)
    at Lt.render (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:4:29014)
    at Lt.render (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1113:31627)
    at P1.buildPrompt (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1642:2200)
    at Ure.buildPrompt (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1630:23413)
    at Ure.buildPrompt2 (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1281:16326)
    at Ure.runOne (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1281:12270)
    at Ure.run (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1281:9677)
    at A0.runWithToolCalling (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1630:16515)
    at A0.getResult (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1630:11887)
    at Wre.getResult (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1634:5885)
    at aR.getResult (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:1653:9118)
    at h3.y (c:\Users\idoom\.vscode\extensions\github.copilot-chat-0.33.2\dist\extension.js:5706:1592)
    at Td.$invokeAgent (file:///c:/Program%20Files/Microsoft%20VS%20Code/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:142:50109): [Agent] summarization failed
```
