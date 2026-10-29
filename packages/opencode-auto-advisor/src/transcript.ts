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

/** Markers for the host catalogs the Advisor does not need; see `compactContext`. */
export const COMPACTED = {
  codeMode: "[context-omitted: Code Mode tool catalog]",
  mcp: "[context-omitted: MCP server instructions]",
  skills: "[context-omitted: skill catalog]",
} as const;

const CODE_MODE_START = "# Code Mode\n\nUse the `execute` tool";
const CODE_MODE_TOOLS = "## Available tools\n\n";
const CODE_MODE_NOTICE =
  "The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n\n";
const SKILLS_START = "Skills provide specialized instructions and workflows for specific tasks.";

interface Catalog {
  readonly start: string;
  readonly marker: string;
  /** The span to replace for a start found at `at`, or undefined when its end is missing. */
  readonly span: (text: string, at: number) => { start: number; end: number } | undefined;
}

const tagged = (close: string) => (text: string, at: number) => {
  const end = text.indexOf(close, at);
  return end < 0 ? undefined : { start: at, end: end + close.length };
};

/**
 * Text OpenCode 2.2.0 renders for its instruction sources (`codemode/`, `mcp/` and
 * `skill/instructions.ts`). Tool lines are joined with single newlines, so the Code Mode catalog
 * ends at the first blank line after its tool header.
 */
const CATALOGS: readonly Catalog[] = [
  {
    start: CODE_MODE_START,
    marker: COMPACTED.codeMode,
    span: (text, at) => {
      const tools = text.indexOf(CODE_MODE_TOOLS, at);
      if (tools < 0) return undefined;
      const blank = text.indexOf("\n\n", tools + CODE_MODE_TOOLS.length);
      const notice = at - CODE_MODE_NOTICE.length;
      return {
        start: notice >= 0 && text.startsWith(CODE_MODE_NOTICE, notice) ? notice : at,
        end: blank < 0 ? text.length : blank,
      };
    },
  },
  { start: "<mcp_instructions>", marker: COMPACTED.mcp, span: tagged("</mcp_instructions>") },
  { start: SKILLS_START, marker: COMPACTED.skills, span: tagged("</available_skills>") },
];

/**
 * Replaces the host's Code Mode, MCP and skill catalogs with markers. A block whose end is
 * missing before the next copy starts is kept, so a change in the host's wording costs tokens,
 * never other context.
 */
export function compactContext(text: string): string {
  let out = text;
  for (const catalog of CATALOGS) {
    let from = 0;
    for (let at = out.indexOf(catalog.start); at >= 0; at = out.indexOf(catalog.start, from)) {
      // An end found past the next copy's start belongs to that copy: keep this broken one.
      const next = out.indexOf(catalog.start, at + 1);
      const span = catalog.span(out, at);
      if (!span || (next >= 0 && span.end > next)) {
        from = at + 1;
        continue;
      }
      out = out.slice(0, span.start) + catalog.marker + out.slice(span.end);
      from = span.start + catalog.marker.length;
    }
  }
  return out;
}

const compactSystemMessage = (message: Message): Message => {
  if (message.role !== "system") return message;
  if (typeof message.content === "string") {
    return { ...message, content: compactContext(message.content) };
  }
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "text" && typeof part.text === "string"
        ? { ...part, text: compactContext(part.text) }
        : part,
    ),
  };
};

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

/**
 * Index of the latest real user prompt. Synthetic, skill, shell and compaction messages are
 * `role: "user"` too, so when the ids of real prompts are known (recorded by the `prompt` hook)
 * only those count.
 */
function promptIndex(messages: readonly Message[], prompts?: ReadonlySet<string>): number {
  if (prompts?.size) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const id = messages[i].id;
      if (messages[i].role === "user" && id && prompts.has(id)) return i;
    }
  }
  return lastUserIndex(messages);
}

export const DECISION_INPUT_MAX_CHARS = 32_000;
const DECISION_RECENT_LINES = 12;
const DECISION_LINE_MAX = 1_000;
const DECISION_REQUEST_MAX = 4_000;

/**
 * What the Decision model sees: the latest request, the current turn's recent steps and two
 * counts. No system prompt or tool definitions: this goes to a third-party decision provider.
 */
export function decisionInput(messages: readonly Message[], prompts?: ReadonlySet<string>): string {
  const start = promptIndex(messages, prompts);
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

/** The id of the latest real user prompt: the key the per-turn budget counts against. */
export function turnKey(
  messages: readonly Message[],
  prompts?: ReadonlySet<string>,
): string | undefined {
  const index = promptIndex(messages, prompts);
  return index >= 0 ? (messages[index].id ?? `index:${index}`) : undefined;
}

/**
 * What the Advisor sees: system text, tool names and the transcript. Over budget it keeps the
 * system text, the first user message and as many of the newest messages as fit, with every part
 * and every message capped at a quarter of the budget so no single message can crowd out the rest.
 */
export function advisorTranscript(input: {
  readonly system: readonly SystemText[];
  readonly tools: readonly string[];
  readonly messages: readonly Message[];
  readonly budgetChars: number;
  /** Replace the host catalogs in system text; user and tool content is never changed. */
  readonly compact?: boolean;
}): string {
  const joined = input.system.map((part) => part.text).join("\n\n");
  const system = input.compact ? compactContext(joined) : joined;
  const messages = input.compact ? input.messages.map(compactSystemMessage) : input.messages;
  const render = (partMax: number) => {
    const head = [
      `SYSTEM PROMPT:\n${truncate(system, partMax)}`,
      `AVAILABLE TOOLS: ${input.tools.join(", ") || "(none)"}`,
    ].join("\n\n");
    // Cap whole messages too: one step's parallel tool results share a message, and the
    // newest message must still fit after the system text and the first request.
    const blocks = messages.map((message) =>
      truncate(renderMessage(message, partMax).join("\n"), partMax),
    );
    return { head, blocks };
  };

  const full = render(Number.POSITIVE_INFINITY);
  const all = [full.head, ...full.blocks.filter(Boolean)].join("\n\n");
  if (all.length <= input.budgetChars) return all;

  const { head, blocks } = render(Math.floor(input.budgetChars / 4));
  const first = messages.findIndex(isUserPrompt);
  const firstBlock = first >= 0 ? blocks[first] : "";
  const kept: string[] = [];
  let used = head.length + firstBlock.length + OMISSION_MARKER.length + 6;
  for (let i = blocks.length - 1; i > first; i--) {
    const block = blocks[i];
    if (!block) continue;
    if (used + block.length + 2 > input.budgetChars) break;
    kept.unshift(block);
    used += block.length + 2;
  }
  return [head, firstBlock, OMISSION_MARKER, ...kept].filter(Boolean).join("\n\n");
}
