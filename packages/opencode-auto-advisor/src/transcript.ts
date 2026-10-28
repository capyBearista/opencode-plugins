/**
 * Plain-text renderings of a model request: a small one for the Decision model and a large,
 * budgeted one for the Advisor. Inputs are the `context` hook's `system`/`messages`, typed loosely
 * because only a few part shapes matter here and the rest are rendered generically.
 */

export interface Part {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Message {
  readonly role: string;
  readonly id?: string;
  readonly content: string | readonly Part[];
}

export interface SystemText {
  readonly text: string;
}

export const OMISSION_MARKER =
  "[context-omitted: earlier messages were left out to fit the budget]";

const json = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [${text.length - max} chars truncated]`;
}

const parts = (message: Message): readonly Part[] =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;

function renderPart(role: string, part: Part, max: number): string | undefined {
  switch (part.type) {
    case "text": {
      const label = role === "system" ? "SYSTEM UPDATE" : role.toUpperCase();
      return `${label}: ${truncate(String(part.text ?? ""), max)}`;
    }
    case "tool-call":
      return `TOOL CALL ${String(part.name)}: ${truncate(json(part.input), max)}`;
    case "tool-result": {
      const result = part.result as { type?: string; value?: unknown } | undefined;
      const status = result?.type === "error" ? " (error)" : "";
      return `TOOL RESULT ${String(part.name)}${status}: ${truncate(json(result?.value), max)}`;
    }
    case "media":
    case "file":
      return `[${part.type} attachment${part.filename ? ` ${String(part.filename)}` : ""}: contents not inspected]`;
    case "compaction":
      return typeof part.text === "string"
        ? `COMPACTED HISTORY SUMMARY: ${truncate(part.text, max)}`
        : "[compacted history: summary unavailable]";
    default:
      // Reasoning, effort and provider-specific parts carry nothing the reviewers need.
      return undefined;
  }
}

export function renderMessage(message: Message, max = Number.POSITIVE_INFINITY): string[] {
  const lines: string[] = [];
  for (const part of parts(message)) {
    const line = renderPart(message.role, part, max);
    if (line) lines.push(line);
  }
  return lines;
}

const isUserPrompt = (message: Message) =>
  message.role === "user" && parts(message).some((part) => part.type === "text");

function lastUserIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isUserPrompt(messages[i])) return i;
  return -1;
}

export const DECISION_INPUT_MAX_CHARS = 32_000;
const DECISION_RECENT_LINES = 12;
const DECISION_LINE_MAX = 1_000;
const DECISION_REQUEST_MAX = 4_000;

/**
 * What the Decision model sees: the latest request, the current turn's recent steps and two
 * counts. No system prompt or tool definitions: this goes to a third-party decision provider.
 */
export function decisionInput(messages: readonly Message[]): string {
  const start = lastUserIndex(messages);
  const request = start >= 0 ? renderMessage(messages[start], DECISION_REQUEST_MAX).join("\n") : "";
  const turn = messages.slice(start + 1);
  const steps = turn.filter((message) => message.role === "assistant").length;
  const errors = turn
    .flatMap(parts)
    .filter(
      (part) => part.type === "tool-result" && (part.result as { type?: string })?.type === "error",
    ).length;
  const recent = turn
    .flatMap((message) => renderMessage(message, DECISION_LINE_MAX))
    .slice(-DECISION_RECENT_LINES);
  const text = [
    `Latest user request:\n${request || "(none)"}`,
    `Recent steps this turn:\n${recent.join("\n") || "(none yet)"}`,
    `Steps this turn: ${steps}. Tool errors this turn: ${errors}.`,
  ].join("\n\n");
  return truncate(text, DECISION_INPUT_MAX_CHARS);
}

/**
 * The id of the latest user prompt: the key the per-turn budget counts against. Synthetic, skill,
 * shell and compaction messages are `role: "user"` too, so when the ids of real prompts are known
 * (recorded by the `prompt` hook) only those count.
 */
export function turnKey(
  messages: readonly Message[],
  prompts?: ReadonlySet<string>,
): string | undefined {
  if (prompts?.size) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const id = messages[i].id;
      if (messages[i].role === "user" && id && prompts.has(id)) return id;
    }
  }
  const index = lastUserIndex(messages);
  return index >= 0 ? (messages[index].id ?? `index:${index}`) : undefined;
}

/**
 * What the Advisor sees: system text, tool names and the transcript. Over budget it keeps the
 * system text, the first user message and as many of the newest messages as fit.
 */
export function advisorTranscript(input: {
  readonly system: readonly SystemText[];
  readonly tools: readonly string[];
  readonly messages: readonly Message[];
  readonly budgetChars: number;
}): string {
  const head = [
    `SYSTEM PROMPT:\n${input.system.map((part) => part.text).join("\n\n")}`,
    `AVAILABLE TOOLS: ${input.tools.join(", ") || "(none)"}`,
  ].join("\n\n");
  const blocks = input.messages.map((message) => renderMessage(message).join("\n")).filter(Boolean);
  const total = (list: readonly string[]) => list.reduce((sum, block) => sum + block.length + 2, 0);
  if (head.length + total(blocks) <= input.budgetChars) return [head, ...blocks].join("\n\n");

  const first = input.messages.findIndex(isUserPrompt);
  const kept: string[] = [];
  const firstBlock = first >= 0 ? renderMessage(input.messages[first]).join("\n") : "";
  let used = head.length + firstBlock.length + OMISSION_MARKER.length + 6;
  for (let i = input.messages.length - 1; i > first; i--) {
    const block = renderMessage(input.messages[i]).join("\n");
    if (!block) continue;
    if (used + block.length + 2 > input.budgetChars) break;
    kept.unshift(block);
    used += block.length + 2;
  }
  return [head, firstBlock, OMISSION_MARKER, ...kept].filter(Boolean).join("\n\n");
}
