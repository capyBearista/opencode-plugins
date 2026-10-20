import { describeMedia, type MediaPlaceholder } from "./media.js";
import type { AssembledContentPart, AssembledMessage } from "./messages.js";
import type { SerializedEntry } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";
import { stableStringify } from "./stable.js";

type MediaPart = Extract<AssembledContentPart, { type: "media" }>;
type ToolCallPart = Extract<AssembledContentPart, { type: "tool-call" }>;
type ToolResultPart = Extract<AssembledContentPart, { type: "tool-result" }>;

export function serializeRequestMessage(
  message: AssembledMessage,
  agent: string,
  model: string,
): readonly SerializedEntry[] {
  if (message.role === "system") {
    return [{ role: "system", text: textOf(message.content) }, ...unknownMarkers(message.content)];
  }
  if (message.role === "assistant") {
    return [
      { role: "assistant", agent, model, inFlight: false, blocks: blocksOf(message.content) },
    ];
  }
  if (message.role === "tool") return [{ role: "tool", blocks: blocksOf(message.content) }];
  return userEntry(message);
}

function userEntry(message: AssembledMessage): readonly SerializedEntry[] {
  const media = message.content.flatMap((part) =>
    part.type === "media" ? [mediaPlaceholder(part)] : [],
  );
  const text = textOf(message.content);
  return [
    {
      role: "user",
      text,
      ...(media.length > 0 ? { media } : {}),
    },
    ...unknownMarkers(message.content),
  ];
}

function unknownMarkers(content: readonly AssembledContentPart[]): readonly SerializedEntry[] {
  return content
    .filter((part) => !isKnownPart(part))
    .map((part) => ({ role: "marker" as const, type: "unknown", detail: String(part.type) }));
}

function isKnownPart(part: AssembledContentPart): boolean {
  switch (part.type) {
    case "text":
    case "reasoning":
    case "media":
    case "tool-call":
    case "tool-result":
    case "compaction":
    case "effort":
      return true;
    default:
      return false;
  }
}

function blocksOf(content: readonly AssembledContentPart[]): AssistantBlock[] {
  return content.flatMap((part): AssistantBlock[] => {
    const partType = String(part.type);
    switch (part.type) {
      case "text":
        return [{ type: "text", text: part.text }];
      case "reasoning":
        return [{ type: "reasoning", text: part.text }];
      case "media":
        return [{ type: "media", media: mediaPlaceholder(part) }];
      case "tool-call":
        return [callBlock(part)];
      case "tool-result":
        return resultBlocks(part);
      case "compaction":
        return [
          {
            type: "marker",
            marker: "compaction",
            ...(part.text ? { detail: part.text } : {}),
          },
        ];
      case "effort":
        return [
          {
            type: "marker",
            marker: "effort",
            ...(part.effort ? { detail: String(part.effort) } : {}),
          },
        ];
      default:
        return [{ type: "marker", marker: "unknown", detail: partType }];
    }
  });
}

function callBlock(part: ToolCallPart): AssistantBlock {
  return { type: "tool-call", id: part.id, name: part.name, status: "running", input: part.input };
}

function resultBlocks(part: ToolResultPart): AssistantBlock[] {
  const result = part.result;
  if (result.type === "error") {
    return [
      {
        type: "tool-error",
        id: part.id,
        name: part.name,
        error: { type: "tool.error", message: valueText(result.value) ?? "tool error" },
      },
    ];
  }
  if (result.type === "content") {
    const text = result.value
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const media = result.value
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
  const text = valueText(result.value);
  return [{ type: "tool-result", id: part.id, name: part.name, ...(text ? { text } : {}) }];
}

function mediaPlaceholder(part: MediaPart): MediaPlaceholder {
  const asset = part.media;
  const source = asset.source;
  return describeMedia({
    mime: asset.mediaType,
    name: part.filename,
    ...(source.type === "url" ? { uri: source.url } : {}),
    ...(source.type === "base64" ? { data: source.data } : {}),
  });
}

function textOf(content: readonly AssembledContentPart[]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function valueText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return stableStringify(value);
  } catch {
    return undefined;
  }
}
