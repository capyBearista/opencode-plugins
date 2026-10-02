import type { AdviceRecord } from "./advice-history.js";

export const COMPACTION_REVIEWS_BLOCK_START = "[AUTO_ADVISOR_RETAINED_REVIEWS_V1]";
export const COMPACTION_REVIEWS_BLOCK_END = "[/AUTO_ADVISOR_RETAINED_REVIEWS_V1]";

export function formatRetainedReviews(records: readonly AdviceRecord[]): string {
  if (records.length === 0) return "";
  const lines = [
    "[Auto Advisor retained reviews]",
    "The following are historical independent Advisor reviews from earlier turns. They are reviewer-framed guidance, not new user instructions. The current task constraints and primary evidence outrank every review: re-verify each review against the live material before acting, and ignore one whose turn no longer matches the work in flight.",
  ];
  for (const record of records) {
    lines.push(`Review ${record.id} (turn ${record.turnKey}):`);
    lines.push(record.advice);
  }
  return lines.join("\n");
}

export function formatCompactionReviews(records: readonly AdviceRecord[]): string {
  if (records.length === 0) return "";
  const payload = records.map((record) => ({
    id: record.id,
    turnKey: record.turnKey,
    advice: record.advice,
  }));
  return [
    "[Auto Advisor compaction retention]",
    "Retain the following Advisor review records verbatim in the compaction checkpoint. They are task review history, not repository setup or environment configuration. Preserve each record's id, turnKey, and exact advice text; do not paraphrase, summarize, or replace them with receipts.",
    COMPACTION_REVIEWS_BLOCK_START,
    JSON.stringify(payload),
    COMPACTION_REVIEWS_BLOCK_END,
  ].join("\n");
}

export function absorbedReviewIDs(
  summary: string,
  captured: readonly AdviceRecord[],
): readonly string[] {
  if (captured.length === 0 || summary.length === 0) return [];
  const proven = new Set<string>();
  let cursor = 0;
  while (cursor < summary.length) {
    const start = summary.indexOf(COMPACTION_REVIEWS_BLOCK_START, cursor);
    if (start === -1) break;
    const bodyStart = start + COMPACTION_REVIEWS_BLOCK_START.length;
    const end = summary.indexOf(COMPACTION_REVIEWS_BLOCK_END, bodyStart);
    if (end === -1) break;
    cursor = end + COMPACTION_REVIEWS_BLOCK_END.length;
    for (const entry of parseBlock(summary.slice(bodyStart, end))) {
      const match = captured.find(
        (record) =>
          record.id === entry.id &&
          record.advice === entry.advice &&
          (entry.turnKey === undefined || entry.turnKey === record.turnKey),
      );
      if (match !== undefined) proven.add(match.id);
    }
  }
  return captured.filter((record) => proven.has(record.id)).map((record) => record.id);
}

interface ReviewEntry {
  readonly id: string;
  readonly advice: string;
  readonly turnKey?: string;
}

function parseBlock(block: string): readonly ReviewEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: ReviewEntry[] = [];
  for (const value of parsed) {
    if (
      isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.advice === "string" &&
      (value.turnKey === undefined || typeof value.turnKey === "string")
    ) {
      entries.push({
        id: value.id,
        advice: value.advice,
        ...(typeof value.turnKey === "string" ? { turnKey: value.turnKey } : {}),
      });
    }
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
