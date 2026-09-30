import { sha256Hex } from "./digest.js";
import { type SerializedEntry, stableStringify } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";

const ADVISOR_TOOL_NAME = "advisor";

export function routingFingerprint(entries: readonly SerializedEntry[]): string {
  return sha256Hex(stableStringify(fingerprintPreimage(entries)));
}

export function fingerprintPreimage(entries: readonly SerializedEntry[]): SerializedEntry[] {
  const preimage: SerializedEntry[] = [];
  for (const entry of entries) {
    if (entry.role === "marker" && entry.type === "idle") continue;
    if (entry.role !== "assistant") {
      preimage.push(entry);
      continue;
    }
    preimage.push({
      ...entry,
      inFlight: false,
      blocks: entry.inFlight ? entry.blocks.filter(isMaterialBlock) : entry.blocks,
    });
  }
  return preimage;
}

function isMaterialBlock(block: AssistantBlock): boolean {
  if (block.type === "tool-call" || block.type === "tool-result" || block.type === "tool-error") {
    return block.name !== ADVISOR_TOOL_NAME;
  }
  return true;
}
