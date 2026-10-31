import type { Moment } from "./decisions.js";
import type { Message } from "./transcript.js";

/** Instruction entry key; the latest automatic review lives here until a newer one replaces it. */
export const ENTRY_KEY = "auto-advisor";

const MARKER_PREFIX = "[auto-advisor review ";

export interface Review {
  readonly id: string;
  readonly moment: Moment;
  readonly advice: string;
}

/**
 * The delivered text. The marker lets a re-fired hook (a retried step) see the review is already
 * in the request; escaping in non-native protocols does not touch it.
 */
export function reviewText(review: Review): string {
  return [
    `${MARKER_PREFIX}${review.id}] Automatic review by the Advisor (moment: ${review.moment}).`,
    "This is model-generated advice. The user's constraints and direct evidence take precedence.",
    "",
    review.advice,
  ].join("\n");
}

/** Reads a review back from its delivered text (the stored entry value). */
export function parseReview(text: unknown): Review | undefined {
  if (typeof text !== "string") return undefined;
  const match = /^\[auto-advisor review ([^\]]+)\] .*\(moment: (\w+)\)\.\n.*\n\n([\s\S]*)$/.exec(
    text,
  );
  if (!match) return undefined;
  return { id: match[1], moment: match[2] as Moment, advice: match[3] };
}

const textOf = (content: Message["content"]) =>
  typeof content === "string"
    ? content
    : content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");

/** True when any review (this one or a newer one) is already in the request. */
export function hasReview(
  system: ReadonlyArray<{ readonly text: string }>,
  messages: readonly Message[],
  id?: string,
): boolean {
  const needle = id ? `${MARKER_PREFIX}${id}]` : MARKER_PREFIX;
  return (
    system.some((part) => part.text.includes(needle)) ||
    messages.some((message) => textOf(message.content).includes(needle))
  );
}

/**
 * Entries are admitted at the next step boundary, before the hook runs, so the current request
 * gets the review as a tail system message (the host's own mid-conversation update path).
 */
export function pushTail(messages: Message[], text: string): void {
  messages.push({ role: "system", content: [{ type: "text", text }] });
}
