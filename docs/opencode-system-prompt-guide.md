# OpenCode System Prompt Architecture Guide

This guide provides a detailed technical overview of how OpenCode constructs and manages its system prompts. It is intended for plugin contributors who need to understand the underlying mechanisms for prompt manipulation.

## 1. The Prompt Assembly Pipeline

OpenCode does not use a single, static system prompt. Instead, it dynamically assembles a system prompt "payload" for every LLM request. This process happens primarily in `packages/opencode/src/session/prompt.ts` and `packages/opencode/src/session/llm.ts`.

### Logical Components
The final system prompt is a concatenation of the following pieces (in order):

1.  **Base Provider Template:** A model-specific foundation.
2.  **Environment Context:** Real-time data about the user's system and project.
3.  **Available Skills:** A comprehensive list of registered tool capabilities.
4.  **Project-Specific Instructions:** Content from `AGENTS.md`, `CLAUDE.md`, or custom config.

## 2. Base Template Selection (`SystemPrompt.provider`)

OpenCode uses different base templates depending on the model provider. This logic is handled by `SystemPrompt.provider(model)` in `packages/opencode/src/session/system.ts`.

*   **Gemini (Google):** Uses `packages/opencode/src/session/prompt/gemini.txt`. This file defines the agent's identity ("opencode"), core mandates (adhering to conventions, library usage), and primary software engineering workflows.
*   **Anthropic:** Uses `packages/opencode/src/session/prompt/anthropic.txt`.
*   **GPT (OpenAI):** Uses `packages/opencode/src/session/prompt/gpt.txt`.

**Contributor Note:** If an agent has a custom `prompt` defined in its configuration (e.g., in `opencode.json` or a custom agent markdown file), that prompt **completely replaces** the provider-specific template.

## 3. Environment Context (`SystemPrompt.environment`)

After the base template, OpenCode injects a block of environmental metadata to ground the LLM in the current workspace. This includes:
*   **Model ID:** The exact model powering the session.
*   **Working Directory:** The absolute path where the CLI was launched.
*   **Workspace Root:** The root directory of the project.
*   **VCS Status:** Whether the directory is a Git repository.
*   **System Info:** Platform (OS) and current date/time.

## 4. Model Switching Mechanisms

When a user switches models mid-session (e.g., via `/models` or the TUI footer), the following occurs:

1.  **State Transition:** The TUI updates its internal `modelID` and `providerID`. No history is cleared.
2.  **History Normalization:** Before the next request, `MessageV2.toModelMessagesEffect(msgs, model)` is called. This converts the existing conversation (including tool calls and results) into the specific message format required by the new model's API.
3.  **Prompt Regeneration:** The system prompt assembly pipeline is triggered from scratch for the new model. This ensures the agent is immediately aware of its new "identity" and the capabilities of the new provider.

## 5. Plan Mode & System Reminders

Plan mode operates through **synthetic system reminders** rather than swapping the base prompt. 

*   **`plan.txt`:** When the `plan` agent is active, the content of `packages/opencode/src/session/prompt/plan.txt` is appended as a synthetic text part to the user's message. This reminder forces the LLM into a read-only state.
*   **`build-switch.txt`:** When switching back from Plan to Build mode, the system injects the content of `packages/opencode/src/session/prompt/build-switch.txt`. This acts as a clear "permission restored" signal to the LLM.

## 6. Plugin Hook: `experimental.chat.system.transform`

This is the primary entry point for plugins like `opencode-output-styles`. 

*   **Location:** `packages/opencode/src/session/llm.ts`.
*   **Input:** The `sessionID` and the current `model` object.
*   **Output:** The `system` array (passed by reference).

Plugins can mutate this array to:
*   Prepend instructions (`output.system.unshift`).
*   Replace the base prompt (`output.system[0] = "..."`).
*   Append custom styles or rules (`output.system.push`).

By the time this hook fires, `output.system[0]` contains the joined string of the base template, environment, skills, and project instructions.
