import type { ContextMessage, ModelReference, SessionID } from "./messages.js";
import {
  type SerializedEntry,
  serializeAdvisorContext,
  serializeMessage,
  stableStringify,
} from "./serialize.js";

export interface AdvisorContextSession {
  readonly context: (input: {
    readonly sessionID: SessionID;
  }) => Promise<readonly ContextMessage[]>;
}

export interface AdvisorContextInput {
  readonly sessionID: SessionID;
  readonly messageID: string;
}

export interface CapturedAdvisorContext {
  readonly entries: readonly SerializedEntry[];
  readonly transcript: string;
  readonly executorModel?: ModelReference;
  readonly lastUserMessageID?: string;
}

export async function captureAdvisorContext(
  session: AdvisorContextSession,
  input: AdvisorContextInput,
): Promise<CapturedAdvisorContext> {
  const messages = await session.context({ sessionID: input.sessionID });
  const entries = messages.map((message) => serializeMessage(message, input.messageID));
  const executorModel = resolveExecutorModel(messages, input.messageID);
  const lastUserMessageID = resolveLastUserMessageID(messages);
  return {
    entries,
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
