import type { CapturedHistory } from "./context.js";
import { sha256Hex } from "./digest.js";
import type { AssembledRequest, ModelReference, SessionID } from "./messages.js";
import { serializeRequestMessage } from "./request-serialize.js";
import type { SerializedEntry } from "./serialize.js";
import { refKey } from "./serialize-assistant.js";
import { stableStringify } from "./stable.js";

export interface CapturedRequest {
  readonly sessionID: SessionID;
  readonly entries: readonly SerializedEntry[];
  readonly turnKey: string;
  readonly executorModel: ModelReference;
}

export function captureAssembledRequest(request: AssembledRequest): CapturedRequest {
  const agent = String(request.agent);
  const model = refKey(request.model);
  const entries: SerializedEntry[] = request.system.map((part) => ({
    role: "system" as const,
    text: part.text,
  }));
  for (const message of request.messages) {
    entries.push(...serializeRequestMessage(message, agent, model));
  }
  return {
    sessionID: request.sessionID,
    entries,
    turnKey: turnKeyFor(request, entries, agent, model),
    executorModel: modelReference(request),
  };
}

function turnKeyFor(
  request: AssembledRequest,
  entries: readonly SerializedEntry[],
  agent: string,
  model: string,
): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (!message || message.role !== "user") continue;
    const body = serializeRequestMessage(message, agent, model);
    if (message.id) return message.id;
    return contentTurnKey(index, body);
  }
  return `content:no-user:${sha256Hex(stableStringify(entries))}`;
}

export function turnKeyForHistory(history: CapturedHistory): string {
  for (let index = history.messageIDs.length - 1; index >= 0; index -= 1) {
    const entry = history.entries[index];
    if (!entry || entry.role !== "user") continue;
    const messageID = history.messageIDs[index];
    if (messageID) return messageID;
    return contentTurnKey(index, [entry]);
  }
  return `content:no-user:${sha256Hex(stableStringify(history.entries))}`;
}

function contentTurnKey(index: number, body: unknown): string {
  return `content:${index}:${sha256Hex(stableStringify(body))}`;
}

function modelReference(request: AssembledRequest): ModelReference {
  const variant = request.model.variant;
  return {
    providerID: String(request.model.providerID),
    id: String(request.model.id),
    ...(variant ? { variant: String(variant) } : {}),
  };
}
