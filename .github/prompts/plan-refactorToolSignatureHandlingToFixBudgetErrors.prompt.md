## Plan: Refactor Tool Signature Handling to Fix Budget Errors

The current method of embedding model "thought signatures" into tool call IDs is causing token budget overruns in the chat agent. This plan refactors the implementation to store these signatures in a temporary map within the provider, avoiding the oversized IDs and resolving the subsequent summarization errors.

### Steps
1. **Introduce a signature cache**
   - Add a new `Map` property, `_toolSignatures`, to the `HuggingFaceChatModelProvider` class in `src/provider.ts` to cache signatures between requests.

2. **Update tool call emission logic**
   - In `tryEmitBufferedToolCall` and `flushToolCallBuffers` in `src/provider.ts`, stop encoding signatures into the tool call ID. Instead, use the original short ID for `LanguageModelToolCallPart` and store the signature in the new `_toolSignatures` map.

3. **Revise request preparation logic**
   - In `provideLanguageModelChatResponse` in `src/provider.ts`, modify the message processing loop. Instead of splitting signatures from IDs, look up the tool call ID in the `_toolSignatures` map. If a signature is found, inject it into the `provider_specific_fields` of the tool call and remove the entry from the map.

4. **Remove obsolete ID manipulation**
   - Delete the code block responsible for parsing the `GEMINI_SIG_SEPARATOR` from `tool` message `tool_call_id`s, as it will no longer be needed.

5. **After done**
   - Write report of this plan and summary to `research` directory.

### Further Considerations
1. This approach relies on the provider instance's state persisting between the tool-call response and the tool-result request. This is consistent with the existing implementation but is an important assumption to be aware of.

