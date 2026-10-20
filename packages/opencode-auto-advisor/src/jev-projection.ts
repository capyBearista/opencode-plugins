import type { CanonicalState } from "./canonical.js";
import { materialBlocks } from "./material.js";
import type { MediaPlaceholder } from "./media.js";
import type { SerializedEntry } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";
import { stableStringify } from "./stable.js";

export const JEV_MAX_OBJECTIVE_CHARS = 1200;
export const JEV_MAX_OBJECTIVE_MEDIA = 3;
export const JEV_MAX_ASSISTANT_TEXT_BLOCKS = 3;
export const JEV_MAX_ASSISTANT_TEXT_CHARS = 400;
export const JEV_MAX_TOOL_ACTIVITY = 8;
export const JEV_MAX_TOOL_DETAIL_CHARS = 300;
export const JEV_MAX_TOOL_VALUE_CHARS = 120;
export const JEV_MAX_TOOL_ARRAY_ITEMS = 8;
export const JEV_MAX_TOOL_VALUE_DEPTH = 6;
export const JEV_MAX_RECENT_TURNS = 2;
export const JEV_MAX_HISTORY_USER_CHARS = 300;
export const JEV_MAX_HISTORY_ASSISTANT_CHARS = 300;

type UserEntry = Extract<SerializedEntry, { role: "user" }>;

export type JevMediaHint = {
  readonly kind: string;
  readonly mime: string;
  readonly name?: string;
};

export type JevObjective = {
  readonly text: string;
  readonly media?: readonly JevMediaHint[];
};

export type JevToolActivity = {
  readonly kind: "call" | "result" | "error";
  readonly name: string;
  readonly detail?: string;
};

export type JevCurrentTurn = {
  readonly assistantText: readonly string[];
  readonly toolActivity: readonly JevToolActivity[];
};

export type JevHistoryTurn = {
  readonly userText: string;
  readonly assistantText?: string;
};

export type JevExecutor = {
  readonly agent: string;
  readonly model: string;
};

export type JevRoutingProjection = {
  readonly objective?: JevObjective;
  readonly currentTurn: JevCurrentTurn;
  readonly recentHistory: readonly JevHistoryTurn[];
  readonly omittedHistoryTurns: number;
  readonly executor?: JevExecutor;
};

export function buildJevRoutingProjection(state: CanonicalState): JevRoutingProjection {
  const lastUser = lastUserIndex(state);
  const objective = lastUser < 0 ? undefined : objectiveOf(state[lastUser] as UserEntry);
  const settled = lastUser < 0 ? [] : state.slice(0, lastUser);
  const current = lastUser < 0 ? state : state.slice(lastUser + 1);
  const turns = historyTurns(settled);
  const recentHistory = turns.slice(-JEV_MAX_RECENT_TURNS);
  const executor = executorOf(state);
  return {
    ...(objective ? { objective } : {}),
    currentTurn: currentTurnOf(current),
    recentHistory,
    omittedHistoryTurns: turns.length - recentHistory.length,
    ...(executor ? { executor } : {}),
  };
}

function lastUserIndex(state: CanonicalState): number {
  for (let index = state.length - 1; index >= 0; index -= 1) {
    if (state[index]?.role === "user") return index;
  }
  return -1;
}

function objectiveOf(entry: UserEntry): JevObjective {
  const media = (entry.media ?? []).slice(0, JEV_MAX_OBJECTIVE_MEDIA).map(mediaHint);
  return {
    text: excerpt(entry.text, JEV_MAX_OBJECTIVE_CHARS),
    ...(media.length > 0 ? { media } : {}),
  };
}

function mediaHint(media: MediaPlaceholder): JevMediaHint {
  return {
    kind: media.kind,
    mime: media.mime,
    ...(media.name ? { name: media.name } : {}),
  };
}

function currentTurnOf(entries: CanonicalState): JevCurrentTurn {
  const assistantText: string[] = [];
  const toolActivity: JevToolActivity[] = [];
  for (const entry of entries) {
    if (entry.role === "assistant") {
      for (const block of materialBlocks(entry.blocks)) {
        if (block.type === "text") {
          assistantText.push(excerpt(block.text, JEV_MAX_ASSISTANT_TEXT_CHARS));
        } else {
          pushActivity(toolActivity, block);
        }
      }
      continue;
    }
    if (entry.role === "tool") {
      for (const block of materialBlocks(entry.blocks)) pushActivity(toolActivity, block);
    }
  }
  return {
    assistantText: assistantText.slice(-JEV_MAX_ASSISTANT_TEXT_BLOCKS),
    toolActivity: toolActivity.slice(-JEV_MAX_TOOL_ACTIVITY),
  };
}

function pushActivity(activity: JevToolActivity[], block: AssistantBlock): void {
  if (block.type === "tool-call") {
    const detail = detailOf(block.input);
    activity.push({ kind: "call", name: block.name, ...(detail ? { detail } : {}) });
    return;
  }
  if (block.type === "tool-result") {
    const detail = block.text ? excerpt(block.text, JEV_MAX_TOOL_DETAIL_CHARS) : undefined;
    activity.push({ kind: "result", name: block.name, ...(detail ? { detail } : {}) });
    return;
  }
  if (block.type === "tool-error") {
    activity.push({
      kind: "error",
      name: block.name,
      detail: excerpt(block.error.message, JEV_MAX_TOOL_DETAIL_CHARS),
    });
  }
}

function detailOf(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    const serialized = stableStringify(compactValue(input, 0));
    return serialized ? excerpt(serialized, JEV_MAX_TOOL_DETAIL_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return excerpt(value, JEV_MAX_TOOL_VALUE_CHARS);
  if (depth >= JEV_MAX_TOOL_VALUE_DEPTH) return "…";
  if (Array.isArray(value)) {
    return value.slice(0, JEV_MAX_TOOL_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, compactValue(item, depth + 1)]),
    );
  }
  return value;
}

function historyTurns(entries: CanonicalState): JevHistoryTurn[] {
  const turns: JevHistoryTurn[] = [];
  let current: { readonly userText: string; readonly assistantText: string[] } | undefined;
  for (const entry of entries) {
    if (entry.role === "user") {
      if (current) turns.push(finishTurn(current));
      current = { userText: excerpt(entry.text, JEV_MAX_HISTORY_USER_CHARS), assistantText: [] };
      continue;
    }
    if (entry.role !== "assistant" || !current) continue;
    for (const block of materialBlocks(entry.blocks)) {
      if (block.type === "text") current.assistantText.push(block.text);
    }
  }
  if (current) turns.push(finishTurn(current));
  return turns;
}

function finishTurn(turn: {
  readonly userText: string;
  readonly assistantText: string[];
}): JevHistoryTurn {
  const assistant = turn.assistantText.join("\n");
  return {
    userText: turn.userText,
    ...(assistant ? { assistantText: excerpt(assistant, JEV_MAX_HISTORY_ASSISTANT_CHARS) } : {}),
  };
}

function executorOf(entries: CanonicalState): JevExecutor | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === "assistant") return { agent: entry.agent, model: entry.model };
  }
  return undefined;
}

function excerpt(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return `${value.slice(0, Math.max(0, cap - 1))}…`;
}
