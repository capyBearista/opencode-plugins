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

/** Like `truncate`, but keeps the end: a tool's outcome (an exit code, a test summary) is last. */
export function truncateStart(text: string, max: number): string {
  return text.length <= max
    ? text
    : `[${text.length - max} chars truncated] …${text.slice(text.length - max)}`;
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
      return `TOOL RESULT ${String(part.name)}${status}: ${truncateStart(json(result?.value), max)}`;
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

/**
 * OpenCode's shell notices (`core/src/shell/result.ts`, unchanged through 2.2.5). A non-zero exit,
 * a kill or a timeout still completes the tool, so the result is not marked as an error. Only the
 * shell tool appends them; another tool's output (a read log) can contain the same words.
 */
const SHELL_FAILURE = /Exited with code [1-9]|Killed by |Timed out before completion/;
/** `bash` runs the shell tool on 2.2.5, and the call keeps the name the model used. */
const SHELL_TOOLS = new Set(["shell", "bash"]);

const failed = (part: Part) => {
  const result = part.result as { type?: string; value?: unknown } | undefined;
  if (result?.type === "error") return true;
  return SHELL_TOOLS.has(String(part.name)) && SHELL_FAILURE.test(json(result?.value));
};

const DECISION_RECENT_LINES = 12;
const DECISION_LINE_MAX = 1_000;

/** Which user-role messages are the user's own prompts, and how many to show. */
export interface Requests {
  /** Ids of real user prompts; subagent results and other notices are `role: "user"` too. */
  readonly prompts: ReadonlySet<string>;
  readonly requests: number;
  /** Characters per request, keeping the start; -1 is no cap. */
  readonly requestMaxChars: number;
}

export const isRequest = (message: Message, prompts: ReadonlySet<string>) =>
  message.role === "user" && message.id !== undefined && prompts.has(message.id);

/** OpenCode's own wrapper for a subagent's result (`core/src/session/subagent-completion.ts`). */
const isSubagentResult = (message: Message) =>
  parts(message).some((part) => part.type === "text" && String(part.text).startsWith("<subagent "));

/**
 * A message's role is its rendered label. Subagent results, skills, shell and other notices are
 * `role: "user"` too; relabel them so they never read as the user speaking.
 */
const labelled = (messages: readonly Message[], prompts: ReadonlySet<string>) =>
  messages.map((message) =>
    message.role !== "user" || isRequest(message, prompts)
      ? message
      : { ...message, role: isSubagentResult(message) ? "subagent" : "notice" },
  );

/**
 * What the Decision model sees: the user's last few requests, the current turn's recent steps
 * and their outcomes. The turn starts at the latest request in the window. Other user-role
 * messages are labelled for what they are, so they never read as the user speaking. System
 * updates (instruction entries, including earlier reviews) are left out. No system prompt or tool
 * definitions: this goes to a third-party decision provider. There is no total cap: a model whose
 * window is too small fails over to the next one.
 */
export function decisionInput(messages: readonly Message[], input: Requests): string {
  const indexes = messages.flatMap((message, i) => (isRequest(message, input.prompts) ? [i] : []));
  const start = indexes.at(-1) ?? -1;
  const max = input.requestMaxChars < 0 ? Number.POSITIVE_INFINITY : input.requestMaxChars;
  const requests = indexes
    .slice(-input.requests)
    .map((i) => truncate(renderMessage(messages[i]).join("\n"), max));
  const turn = messages.slice(start + 1).filter((message) => message.role !== "system");
  const steps = turn.filter((message) => message.role === "assistant").length;
  const results = turn.flatMap(parts).filter((part) => part.type === "tool-result");
  const latest = results.at(-1);
  const recent = labelled(turn, input.prompts)
    .flatMap((message) => renderMessage(message, DECISION_LINE_MAX))
    .slice(-DECISION_RECENT_LINES);
  return [
    `User requests (oldest first; the last is the latest):\n${requests.join("\n\n") || "(not in context)"}`,
    `Recent steps this turn:\n${recent.join("\n") || "(none yet)"}`,
    `Steps this turn: ${steps}. Failed tool calls this turn: ${results.filter(failed).length}. ` +
      `Latest tool result: ${latest ? (failed(latest) ? "failed" : "ok") : "none"}.`,
  ].join("\n\n");
}

/**
 * What the Advisor sees: system text, tool names and the transcript, labelled like the Decision
 * input. Over budget it keeps the system text, the first real request and as many of the newest messages as fit, with every part
 * and every message capped at a quarter of the budget so no single message can crowd out the rest.
 */
export function advisorTranscript(input: {
  readonly system: readonly SystemText[];
  readonly tools: readonly string[];
  readonly messages: readonly Message[];
  /** Ids of real user prompts, as for `decisionInput`. */
  readonly prompts: ReadonlySet<string>;
  readonly budgetChars: number;
  /** Replace the host catalogs in system text; user and tool content is never changed. */
  readonly compact?: boolean;
}): string {
  const joined = input.system.map((part) => part.text).join("\n\n");
  const system = input.compact ? compactContext(joined) : joined;
  const messages = labelled(
    input.compact ? input.messages.map(compactSystemMessage) : input.messages,
    input.prompts,
  );
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
  const first = messages.findIndex((message) => isRequest(message, input.prompts));
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
