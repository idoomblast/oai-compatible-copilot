# Copilot Instructions for OAI Compatible Copilot

This project is a VS Code extension that integrates OpenAI-compatible inference providers (Hugging Face, Together, Groq, DeepSeek, etc.) into GitHub Copilot Chat.

## Architecture Overview

- **Core Role**: Acts as a bridge between VS Code's `LanguageModelChatProvider` API and external OpenAI-compatible REST APIs.
- **Entry Point**: `src/extension.ts` activates the extension, registers the `oaicopilot` provider, and handles API key management commands.
- **Provider Logic**: `src/provider.ts` (`HuggingFaceChatModelProvider`) contains the core logic:
  - Maps VS Code chat messages to OpenAI format.
  - Handles streaming responses (SSE).
  - Manages tool calls (buffering and emitting `LanguageModelToolCallPart`).
  - Supports "Thinking" models (DeepSeek R1, Gemini 2.0) via `LanguageModelThinkingPart`.
- **Configuration**: Driven by `oaicopilot.models` setting in `package.json`/user settings.

## Critical Workflows

- **Build**: Run `npm run watch` to compile TypeScript in watch mode.
- **Test**: Run `npm run watch-tests` to run tests.
- **Debug**: Use the "Extension Development Host" launch configuration.
- **Lint**: Run `npm run lint`.

## Project Conventions & Patterns

### API Usage
- **Proposed APIs**: This extension heavily relies on proposed VS Code APIs (`chatProvider`, `languageModelThinkingPart`, `languageModelDataPart`).
  - **Do not** attempt to replace these with stable APIs unless the proposal has been finalized in the `engines` version specified in `package.json`.
  - Refer to `src/vscode.proposed.*.d.ts` for type definitions.

### Provider Implementation (`src/provider.ts`)
- **Streaming**: The provider must handle Server-Sent Events (SSE) manually in `processStreamingResponse`.
- **Tool Calls**: Tool calls arrive in chunks. They are buffered in `_toolCallBuffers` and emitted only when complete or when the stream ends.
- **Thinking/Reasoning**:
  - The provider parses `<think>` tags or `thinking`/`reasoning_content` fields from the API response.
  - These are emitted as `vscode.LanguageModelThinkingPart`.
  - **Reasoning Reconstruction**: The provider reconstructs reasoning details from history to handle session restoration (`reconstructReasoningDetails`).

### Configuration & Secrets
- **Models**: Defined in `oaicopilot.models` array. Each item can specify `baseUrl`, `apiKey` (via secret storage), and model-specific parameters (`enable_thinking`, `reasoning`).
- **Secrets**: API keys are stored in `vscode.SecretStorage` via `context.secrets`.
  - Global key: `oaicopilot.apiKey`
  - Provider-specific keys: `oaicopilot.apiKey.{providerName}`

### Error Handling
- **Retry Logic**: Implemented in `executeWithRetry` (in `provider.ts` or `utils.ts`) to handle transient API failures (429, 5xx).
- **User Feedback**: Use `console.error` for internal logging and `vscode.window.showErrorMessage` for user-facing issues.

## Key Files
- `src/extension.ts`: Extension activation and command registration.
- `src/provider.ts`: Main provider implementation (streaming, tools, thinking).
- `src/types.ts`: TypeScript interfaces for OpenAI API objects and internal config.
- `package.json`: Defines contribution points (`languageModelChatProviders`, `configuration`).
