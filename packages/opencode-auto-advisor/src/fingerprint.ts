import { sha256Hex } from "./digest.js";
import { materialBlocks } from "./material.js";
import { type SerializedEntry, stableStringify } from "./serialize.js";

export function routingFingerprint(entries: readonly SerializedEntry[]): string {
  return sha256Hex(stableStringify(fingerprintPreimage(entries)));
}

export function fingerprintPreimage(entries: readonly SerializedEntry[]): SerializedEntry[] {
  const preimage: SerializedEntry[] = [];
  for (const entry of entries) {
    if (entry.role === "marker" && entry.type === "idle") continue;
    if (entry.role === "assistant") {
      const blocks = materialBlocks(entry.blocks);
      if (blocks.length === 0 && entry.blocks.length > 0 && entry.error === undefined) continue;
      preimage.push({ ...entry, inFlight: false, blocks });
      continue;
    }
    if (entry.role === "tool") {
      const blocks = materialBlocks(entry.blocks);
      if (blocks.length === 0 && entry.blocks.length > 0) continue;
      preimage.push({ ...entry, blocks });
      continue;
    }
    preimage.push(entry);
  }
  return preimage;
}
