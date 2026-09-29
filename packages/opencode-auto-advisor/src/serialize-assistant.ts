import { describeMedia, type MediaPlaceholder } from "./media.js";
import type {
  ContextMessage,
  SerializedError,
  ToolContentPart,
  ToolPart,
  ToolStatus,
} from "./messages.js";

type AssistantMessage = Extract<ContextMessage, { type: "assistant" }>;
type AssistantContent = AssistantMessage["content"][number];

export type AssistantBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly status: ToolStatus;
      readonly input: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly text?: string;
      readonly media?: readonly MediaPlaceholder[];
    }
  | {
      readonly type: "tool-error";
      readonly id: string;
      readonly name: string;
      readonly error: SerializedError;
    }
  | { readonly type: "media"; readonly media: MediaPlaceholder }
  | { readonly type: "marker"; readonly marker: string; readonly detail?: string };

export interface SerializedAssistant {
  readonly role: "assistant";
  readonly agent: string;
  readonly model: string;
  readonly inFlight: boolean;
  readonly error?: SerializedError;
  readonly blocks: readonly AssistantBlock[];
}

export function serializeAssistant(
  message: AssistantMessage,
  messageID: string,
): SerializedAssistant {
  return {
    role: "assistant",
    agent: message.agent,
    model: refKey(message.model),
    inFlight: message.id === messageID,
    ...(message.error ? { error: serializeError(message.error) } : {}),
    blocks: message.content.flatMap(serializeBlock),
  };
}

export function refKey(model: {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

function serializeBlock(part: AssistantContent): readonly AssistantBlock[] {
  if (part.type === "text") return [{ type: "text", text: part.text }];
  if (part.type === "reasoning") return [{ type: "reasoning", text: part.text }];
  const call: AssistantBlock = {
    type: "tool-call",
    id: part.id,
    name: part.name,
    status: part.state.status,
    input: part.state.input,
  };
  if (part.state.status === "completed") return [call, ...resultBlock(part, part.state.content)];
  if (part.state.status === "error") {
    return [
      call,
      { type: "tool-error", id: part.id, name: part.name, error: serializeError(part.state.error) },
    ];
  }
  return [call];
}

function resultBlock(
  part: ToolPart,
  content: readonly ToolContentPart[],
): readonly AssistantBlock[] {
  const text = content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const media = content
    .filter((item) => item.type === "file")
    .map((item) => describeMedia({ mime: item.mime, name: item.name, uri: item.uri }));
  return [
    {
      type: "tool-result",
      id: part.id,
      name: part.name,
      ...(text ? { text } : {}),
      ...(media.length > 0 ? { media } : {}),
    },
  ];
}

function serializeError(error: {
  readonly type: string;
  readonly message: string;
}): SerializedError {
  return { type: error.type, message: error.message };
}
