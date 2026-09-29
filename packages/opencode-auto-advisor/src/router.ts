import {
  CONSEQUENCE_MAX,
  CONSEQUENCE_MIN,
  type NormalizedAssessment,
  type RouterAssessment,
} from "./routing-types.js";

export class RouterError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RouterError";
  }
}

export function normalizeAssessment(raw: RouterAssessment): NormalizedAssessment {
  if (typeof raw.advisorWouldHelp !== "number" || !Number.isFinite(raw.advisorWouldHelp)) {
    throw new RouterError(
      `advisorWouldHelp must be a finite number, received ${String(raw.advisorWouldHelp)}`,
    );
  }
  if (
    !Number.isInteger(raw.consequence) ||
    raw.consequence < CONSEQUENCE_MIN ||
    raw.consequence > CONSEQUENCE_MAX
  ) {
    throw new RouterError(
      `consequence must be an integer between ${CONSEQUENCE_MIN} and ${CONSEQUENCE_MAX}, received ${String(raw.consequence)}`,
    );
  }
  return {
    advisorWouldHelp: Math.min(1, Math.max(0, raw.advisorWouldHelp)),
    consequence: raw.consequence,
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
  };
}
