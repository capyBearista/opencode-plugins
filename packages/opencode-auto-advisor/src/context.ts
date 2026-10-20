import type { ContextMessage, ModelReference, SessionID } from "./messages.js";
import {
  type SerializedEntry,
  serializeAdvisorContext,
  serializeMessage,
  stableStringify,
} from "./serialize.js";

export interface AdvisorHistorySession {
  readonly context: (input: {
    readonly sessionID: SessionID;
  }) => Promise<readonly ContextMessage[]>;
}

export interface AdvisorHistoryInput {
  readonly sessionID: SessionID;
  readonly messageID: string;
}

export interface CapturedHistory {
  readonly entries: readonly SerializedEntry[];
  readonly messageIDs: readonly string[];
  readonly transcript: string;
  readonly executorModel?: ModelReference;
  readonly lastUserMessageID?: string;
}

export async function captureSessionHistory(
  session: AdvisorHistorySession,
  input: AdvisorHistoryInput,
): Promise<CapturedHistory> {
  const messages = await session.context({ sessionID: input.sessionID });
  const entries = messages.map((message) => serializeMessage(message, input.messageID));
  const executorModel = resolveExecutorModel(messages, input.messageID);
  const lastUserMessageID = resolveLastUserMessageID(messages);
  return {
    entries,
    messageIDs: messages.map((message) => message.id),
    transcript: serializeAdvisorContext(entries),
    ...(executorModel ? { executorModel } : {}),
    ...(lastUserMessageID ? { lastUserMessageID } : {}),
  };
}

function resolveExecutorModel(
  messages: readonly ContextMessage[],
  messageID: string,
): ModelReference | undefined {
  let latest: ModelReference | undefined;
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    latest = message.model;
    if (message.id === messageID) break;
  }
  return latest;
}

function resolveLastUserMessageID(messages: readonly ContextMessage[]): string | undefined {
  let latest: string | undefined;
  for (const message of messages) {
    if (message.type === "user") latest = message.id;
  }
  return latest;
}

export type { ContextMessage, ModelReference, SerializedEntry, SessionID };
export { serializeAdvisorContext, stableStringify };
