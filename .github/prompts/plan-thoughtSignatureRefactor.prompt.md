### Plan: Refactor Thought Signature Handling with Hashing

The core of this plan is to stop embedding the full, lengthy "thought signature" into the `tool_call_id`. Instead, we will store the signature in a persistent cache provided by VS Code's `workspaceState`, and use a short hash of the signature as a reference in the `tool_call_id`.

---

#### **Step 1: Add a Hashing Utility**

We'll start by creating a simple, non-cryptographic hashing function. This avoids adding heavy dependencies and is sufficient for creating a short, unique key for our cache.

*   **File to Edit**: `src/utils.ts`
*   **Action**: Add a new function `shortHash` to generate a concise hash from a string.

```typescript
// In src/utils.ts

/**
 * Creates a simple, short hash from a string.
 * Not cryptographically secure, but good enough for a unique cache key.
 */
export function shortHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
```

---

#### **Step 2: Update the Provider to Use a Persistent Cache**

Next, we'll modify the `HuggingFaceChatModelProvider` to accept the `ExtensionContext`, which gives us access to `workspaceState` for persistent storage. We will replace the in-memory `_toolSignatures` map with this new cache.

*   **File to Edit**: `src/provider.ts`
*   **Action**:
    1.  Import `ExtensionContext` from `vscode`.
    2.  Add a private `_signatureCache` property to hold the `workspaceState` Memento.
    3.  Update the constructor to accept `context: vscode.ExtensionContext` and initialize `_signatureCache`.
    4.  Remove the now-redundant `private readonly _toolSignatures: Map<string, string> = new Map();`.

```typescript
// In src/provider.ts

import * as vscode from "vscode";
// ... other imports

export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
    // ... existing properties

    private readonly _signatureCache: vscode.Memento;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly secrets: vscode.SecretStorage,
        private readonly userAgent: string
    ) {
        this._signatureCache = context.workspaceState;
    }

    // ... rest of the class
}
```

---

#### **Step 3: Implement the Hashing Logic in `provideLanguageModelChatResponse`**

This is where we intercept historical messages. When we find a message with an old-style long signature, we'll hash it, store it in our new cache, and clean the `tool_call_id` before sending it to the LLM.

*   **File to Edit**: `src/provider.ts`
*   **Action**: Modify the loop inside `provideLanguageModelChatResponse` that processes `openaiMessages`.

```typescript
// In src/provider.ts, inside provideLanguageModelChatResponse

// We iterate through the converted OpenAI messages to fix up IDs and inject metadata.
this._toolSignatures.clear(); // This line can be removed after migrating to the new cache system.
for (const msg of openaiMessages) {
    // 1. Handle Assistant Messages (Tool Calls)
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (typeof tc.id === "string" && tc.id.includes("::")) {
                const [realId, signatureOrHash] = tc.id.split("::");

                if (realId && signatureOrHash) {
                    // Heuristic: A long string is likely a full signature needing to be cached.
                    // A short one is a hash and is already in the cache.
                    const isLikelyFullSignature = signatureOrHash.length > 20;
                    if (isLikelyFullSignature) {
                        const signatureHash = shortHash(signatureOrHash);
                        // Store the full signature in the cache for future lookups.
                        await this._signatureCache.update(signatureHash, signatureOrHash);
                    }
                    // The ID sent to the LLM must always be clean.
                    tc.id = realId;
                }
            }
        }
    }
    // 2. Handle Tool/Function Response Messages
    else if (msg.role === "tool" && typeof msg.tool_call_id === "string") {
        if (msg.tool_call_id.includes("::")) {
            const [realId] = msg.tool_call_id.split("::");
            if (realId) {
                msg.tool_call_id = realId;
            }
        }
    }
}
// ...
```

---

#### **Step 4: Reconstruct the Hashed ID in `tryEmitBufferedToolCall`**

When emitting the `LanguageModelToolCallPart` back to VS Code, we must now reconstruct the `finalId` using the *hash*, not the full signature. This is the key to solving the token budget error.

*   **File to Edit**: `src/provider.ts`
*   **Action**: Update the logic inside `tryEmitBufferedToolCall`.

```typescript
// In src/provider.ts, inside tryEmitBufferedToolCall

private tryEmitBufferedToolCall(
    key: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    isLast: boolean,
) {
    const buf = this._toolCallBuffers.get(key);
    if (!buf || !buf.toolCall.function.name) return;

    // ... parsing logic ...

    const id = buf.toolCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;

    // NEW LOGIC: Reconstruct the finalId using the signature hash from the cache.
    // We assume the signature was generated and cached during the reasoning phase.
    const signature = this._currentReasoningSignature; // Assuming this holds the latest signature
    let finalId = id;
    if (signature) {
        const signatureHash = shortHash(signature);
        // Persist the new signature before using its hash
        this._signatureCache.update(signatureHash, signature);
        finalId = `${id}::${signatureHash}`;
    }

    // ... emitting logic ...
    progress.report(new vscode.LanguageModelToolCallPart(finalId, buf.toolCall.function.name, parameters));
    this._toolCallBuffers.delete(key);
}
```
*Note: This step assumes that `this._currentReasoningSignature` holds the signature generated for the current tool call. If that's not the case, the logic to retrieve the correct signature for the current `id` will need adjustment.*

---

#### **Step 5: Update Extension Activation**

Finally, we need to pass the `ExtensionContext` to the provider's constructor when it's created.

*   **File to Edit**: `src/extension.ts`
*   **Action**: Modify the instantiation of `HuggingFaceChatModelProvider`.

```typescript
// In src/extension.ts, inside activate function

export function activate(context: vscode.ExtensionContext) {
    // ...
    const provider = new HuggingFaceChatModelProvider(context, context.secrets, ua);
    vscode.lm.registerLanguageModelChatProvider("oaicopilot", provider);
    // ...
}
```
