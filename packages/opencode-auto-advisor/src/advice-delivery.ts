import { SystemPart } from "@opencode/ai";
import type { AssembledSystemPart } from "./messages.js";
import { formatRetainedReview, type RetainedReview } from "./retained-review.js";

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
  readonly review: RetainedReview;
}

export function deliverRetainedReview(input: RetainedReviewDeliveryInput): void {
  input.system.push(SystemPart.make(formatRetainedReview(input.review)));
}
