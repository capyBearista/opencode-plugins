import { SystemPart } from "@opencode/ai";
import type { AdviceRecord } from "./advice-history.js";
import { formatRetainedReviews } from "./advice-history-format.js";
import type { AssembledSystemPart } from "./messages.js";
import type { SerializedEntry } from "./serialize.js";

export const ADVISOR_DELIVERY_PREFIX = "[Auto Advisor automatic advice]";

export function advisorAdviceText(advice: string): string {
  return `${ADVISOR_DELIVERY_PREFIX}\n${advice}`;
}

export interface AdviceDeliveryInput {
  readonly system: AssembledSystemPart[];
  readonly advice: string;
}

export function deliverAdvice(input: AdviceDeliveryInput): void {
  input.system.push(SystemPart.make(advisorAdviceText(input.advice)));
}

export interface RetainedReviewDeliveryInput {
  readonly system: AssembledSystemPart[];
  readonly records: readonly AdviceRecord[];
}

export function retainedReviewEntry(records: readonly AdviceRecord[]): SerializedEntry | undefined {
  const text = formatRetainedReviews(records);
  return text.length > 0 ? { role: "system", text } : undefined;
}

export function deliverRetainedReviews(input: RetainedReviewDeliveryInput): boolean {
  const text = formatRetainedReviews(input.records);
  if (text.length === 0) return false;
  input.system.push(SystemPart.make(text));
  return true;
}
