import { describeMedia, type MediaPlaceholder } from "./media.js";
import type { ContextMessage } from "./messages.js";
import {
  type AssistantBlock,
  refKey,
  type SerializedAssistant,
  serializeAssistant,
} from "./serialize-assistant.js";
import { stableStringify } from "./stable.js";

export interface CompactionCheckpoint {
  readonly providerID: string;
  readonly provider: string;
  readonly modelID: string;
  readonly route: string;
  readonly protocol: string;
  readonly endpoint: string;
}

type SerializedEntryBody =
  | { readonly role: "system"; readonly text: string; readonly description?: string }
  | {
      readonly role: "user";
      readonly text: string;
      readonly media?: readonly MediaPlaceholder[];
      readonly agents?: readonly string[];
      readonly skills?: readonly string[];
    }
  | SerializedAssistant
  | {
      readonly role: "compaction";
      readonly status: "running" | "completed" | "failed";
      readonly reason: string;
      readonly summary?: string;
      readonly recent?: string;
      readonly checkpoint?: CompactionCheckpoint;
      readonly error?: { readonly type: string; readonly message: string };
    }
  | { readonly role: "tool"; readonly blocks: readonly AssistantBlock[] }
  | { readonly role: "marker"; readonly type: string; readonly detail?: string };

export type SerializedEntry = SerializedEntryBody;

type UserMessage = Extract<ContextMessage, { type: "user" }>;
type ShellMessage = Extract<ContextMessage, { type: "shell" }>;
type CompactionMessage = Extract<ContextMessage, { type: "compaction" }>;

export function serializeAdvisorContext(entries: readonly SerializedEntry[]): string {
  return stableStringify(entries);
}

export { stableStringify };

export function serializeMessage(message: ContextMessage, messageID: string): SerializedEntry {
  return serializeEntryBody(message, messageID);
}

function serializeEntryBody(message: ContextMessage, messageID: string): SerializedEntry {
  switch (message.type) {
    case "system":
      return {
        role: "system",
        text: message.text,
        ...(message.description ? { description: message.description } : {}),
      };
    case "user":
      return serializeUser(message);
    case "assistant":
      return serializeAssistant(message, messageID);
    case "compaction":
      return serializeCompaction(message);
    case "synthetic":
      return marker("synthetic", message.text);
    case "skill":
      return marker("skill", message.text);
    case "shell":
      return marker("shell", shellDetail(message));
    case "idle":
      return marker("idle", message.outcome);
    case "model-switched":
      return marker(
        "model-switched",
        transition(message.previous ? refKey(message.previous) : undefined, refKey(message.model)),
      );
    case "agent-switched":
      return marker("agent-switched", transition(message.previous, message.agent));
    case "location-switched":
      return marker("location-switched", message.subpath ?? message.projectID);
    default:
      return marker((message as { type?: string }).type ?? "unknown", undefined);
  }
}

function serializeUser(message: UserMessage): SerializedEntry {
  const media = (message.files ?? []).map((file) =>
    describeMedia({
      mime: file.mime,
      name: file.name,
      uri: file.source.type === "uri" ? file.source.uri : undefined,
      data: file.data,
    }),
  );
  const agents = (message.agents ?? []).map((agent) => agent.name);
  const skills = (message.skills ?? []).map((skill) => skill.name);
  return {
    role: "user",
    text: message.text,
    ...(media.length > 0 ? { media } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(skills.length > 0 ? { skills } : {}),
  };
}

function serializeCompaction(message: CompactionMessage): SerializedEntry {
  const base = { role: "compaction" as const, status: message.status, reason: message.reason };
  if (message.status === "failed") {
    return { ...base, error: { type: message.error.type, message: message.error.message } };
  }
  const checkpoint =
    message.status === "completed" ? message.providerContext?.provenance : undefined;
  return {
    ...base,
    summary: message.summary,
    recent: message.recent,
    ...(checkpoint ? { checkpoint: { ...checkpoint } } : {}),
  };
}

function marker(type: string, detail: string | undefined): SerializedEntry {
  return { role: "marker", type, ...(detail ? { detail } : {}) };
}

function shellDetail(message: ShellMessage): string {
  const exit = message.exit === undefined ? "" : ` exit=${message.exit}`;
  const output = message.output ? `\n${message.output.output}` : "";
  return `${message.command} [${message.status}${exit}]${output}`;
}

function transition(previous: string | undefined, current: string): string {
  return previous ? `${previous} -> ${current}` : current;
}
