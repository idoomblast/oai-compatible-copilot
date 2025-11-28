export interface StreamResult {
    type: 'text' | 'tool' | 'thinking';
    content?: string;
    toolCall?: {
        name: string;
        arguments: string;
    };
}

export class KimiToolStreamingParser {
    private buffer = '';
    private inToolSection = false;
    private inToolCall = false;
    private inArguments = false;

    private currentToolName = '';
    private currentToolArgs = '';

    // Kimi K2 Tokens
    private static readonly SECTION_BEGIN = '<|tool_calls_section_begin|>';
    private static readonly CALL_BEGIN = '<|tool_call_begin|>';
    private static readonly ARG_BEGIN = '<|tool_call_argument_begin|>';
    private static readonly CALL_END = '<|tool_call_end|>';

    /**
     * Processes a chunk of text and returns any parsed events (thinking text or tool calls).
     * This parser buffers incomplete tokens to handle stream splits correctly.
     */
    processChunk(chunk: string): StreamResult[] {
        const results: StreamResult[] = [];
        this.buffer += chunk;

        let processedSomething = true;
        while (processedSomething && this.buffer.length > 0) {
            processedSomething = false;

            if (!this.inToolSection) {
                // We are in the normal logic/thinking phase (or seemingly so).
                // Check if we see the start of a tool section.
                const beginIndex = this.buffer.indexOf(KimiToolStreamingParser.SECTION_BEGIN);

                if (beginIndex !== -1) {
                    // Found the section begin.
                    // Everything before it is thinking/text content.
                    if (beginIndex > 0) {
                        results.push({
                            type: 'thinking',
                            content: this.buffer.substring(0, beginIndex)
                        });
                    }
                    // Advance buffer past the token
                    this.buffer = this.buffer.substring(beginIndex + KimiToolStreamingParser.SECTION_BEGIN.length);
                    this.inToolSection = true;
                    processedSomething = true;
                } else {
                    // No token found yet.
                    // But we might have a partial token at the end of the buffer.
                    // We must be careful not to emit that partial text.
                    const potentialSuffix = this.findPartialMatch(this.buffer, KimiToolStreamingParser.SECTION_BEGIN);
                    if (potentialSuffix > 0) {
                        // Safe to emit up to the partial match
                        const safeLength = this.buffer.length - potentialSuffix;
                        if (safeLength > 0) {
                            results.push({
                                type: 'thinking',
                                content: this.buffer.substring(0, safeLength)
                            });
                            this.buffer = this.buffer.substring(safeLength);
                        }
                        // We keep the potential suffix in the buffer and wait for more data.
                        processedSomething = false;
                    } else {
                        // No partial match, emit everything as thinking
                        results.push({
                            type: 'thinking',
                            content: this.buffer
                        });
                        this.buffer = '';
                        processedSomething = true; // Cleared buffer
                    }
                }
            } else {
                // Inside Tool Section
                if (!this.inToolCall) {
                    // Expecting <|tool_call_begin|>
                    // Note: There might be whitespace or newlines between calls
                    const callIndex = this.buffer.indexOf(KimiToolStreamingParser.CALL_BEGIN);

                    if (callIndex !== -1) {
                        // Discard whitespace/junk before the call
                        this.buffer = this.buffer.substring(callIndex + KimiToolStreamingParser.CALL_BEGIN.length);
                        this.inToolCall = true;
                        this.currentToolName = '';
                        this.currentToolArgs = '';
                        processedSomething = true;
                    } else {
                        // Check partial match for CALL_BEGIN
                        // const potentialSuffix = this.findPartialMatch(this.buffer, KimiToolStreamingParser.CALL_BEGIN);
                        // If we have a suffix, keep it. If not, is it just whitespace?
                        // If buffer is getting large and no call, that's weird, but for safety keep buffering?
                        // Or discard non-matching text? For now, keep it simple: just wait.
                        processedSomething = false;
                    }
                } else {
                    // Inside Tool Call
                    // Structure: function_name <|tool_call_argument_begin|> arguments <|tool_call_end|>

                    if (!this.inArguments) {
                        // Looking for argument begin
                        const argIndex = this.buffer.indexOf(KimiToolStreamingParser.ARG_BEGIN);
                        if (argIndex !== -1) {
                            this.currentToolName += this.buffer.substring(0, argIndex);
                            this.buffer = this.buffer.substring(argIndex + KimiToolStreamingParser.ARG_BEGIN.length);
                            this.inArguments = true;
                            processedSomething = true;
                        } else {
                            // Partial match check
                            const potentialSuffix = this.findPartialMatch(this.buffer, KimiToolStreamingParser.ARG_BEGIN);
                            if (potentialSuffix > 0) {
                                this.currentToolName += this.buffer.substring(0, this.buffer.length - potentialSuffix);
                                this.buffer = this.buffer.substring(this.buffer.length - potentialSuffix);
                            } else {
                                this.currentToolName += this.buffer;
                                this.buffer = '';
                            }
                            processedSomething = false; // Wait for more
                        }
                    } else {
                        // In Arguments, looking for end
                        const endIndex = this.buffer.indexOf(KimiToolStreamingParser.CALL_END);
                        if (endIndex !== -1) {
                            this.currentToolArgs += this.buffer.substring(0, endIndex);
                            this.buffer = this.buffer.substring(endIndex + KimiToolStreamingParser.CALL_END.length);

                            // Emit the tool call
                            results.push({
                                type: 'tool',
                                toolCall: {
                                    name: this.currentToolName.trim(),
                                    arguments: this.currentToolArgs.trim()
                                }
                            });

                            this.inArguments = false;
                            this.inToolCall = false;
                            // Might go back to looking for next tool call in the section
                            processedSomething = true;
                        } else {
                            // Partial match check
                            const potentialSuffix = this.findPartialMatch(this.buffer, KimiToolStreamingParser.CALL_END);
                            if (potentialSuffix > 0) {
                                this.currentToolArgs += this.buffer.substring(0, this.buffer.length - potentialSuffix);
                                this.buffer = this.buffer.substring(this.buffer.length - potentialSuffix);
                            } else {
                                this.currentToolArgs += this.buffer;
                                this.buffer = '';
                            }
                            processedSomething = false;
                        }
                    }
                }
            }
        }

        return results;
    }

    /**
     * Flushes any remaining buffer as thinking content.
     * This is called when the stream ends to ensure no text is lost.
     */
    flush(): StreamResult[] {
        const results: StreamResult[] = [];
        if (this.buffer.length > 0) {
            // If we have leftover buffer, treated as thinking content
            results.push({
                type: 'thinking',
                content: this.buffer
            });
            this.buffer = '';
        }
        return results;
    }

    private findPartialMatch(text: string, token: string): number {
        // Returns the length of the longest suffix of 'text' that is also a prefix of 'token'.
        // Limit check to token length.
        const maxLen = Math.min(text.length, token.length - 1);
        for (let i = maxLen; i > 0; i--) {
            const suffix = text.substring(text.length - i);
            const prefix = token.substring(0, i);
            if (suffix === prefix) {
                return i;
            }
        }
        return 0;
    }
}
