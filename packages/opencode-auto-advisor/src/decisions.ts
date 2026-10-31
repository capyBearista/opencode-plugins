import { type ModelRef, modelKey } from "./config.js";

export type Moment = "approach" | "stuck" | "done" | "routine";

/** Claude Code's documented advisor moments, plus `routine` for everything else. */
const MOMENTS: ReadonlyArray<{ value: Moment; description: string }> = [
  {
    value: "approach",
    description:
      "The agent has oriented itself (read or searched) and is about to commit to an approach or make its first substantive change.",
  },
  {
    value: "stuck",
    description:
      "The agent is repeating a failing action, the same error keeps recurring, or it is changing approach after failures. A first failure the agent is now fixing is routine.",
  },
  {
    value: "done",
    description:
      "The latest request, read with the earlier ones, looks complete: the latest checks passed, no failure is unresolved, and the next step is reporting to the user. A finished subtask, a returned subagent, a loaded skill or a failed or partial check is not done.",
  },
  {
    value: "routine",
    description:
      "Anything else: carrying out an established plan, or mechanical, read-only or easily reversed steps.",
  },
];

/** Reused from the 2.0.21 plan's consequence rubric. */
const CONSEQUENCE_LEVELS = [
  {
    label: "trivial",
    description: "No meaningful consequence; proceeding without review costs nothing.",
  },
  { label: "minor", description: "A minor inconvenience that is easily reversed." },
  { label: "moderate", description: "Moderate rework or a mistake visible to the user." },
  {
    label: "serious",
    description: "Data loss risk, security-relevant, or hard-to-reverse production impact.",
  },
  { label: "critical", description: "Irreversible harm with a wide blast radius." },
];

export const QUESTIONS = [
  {
    name: "moment",
    type: "choice" as const,
    instructions:
      "This is a coding agent's work in progress. Which moment is it at, judged from the user's requests (the last is the latest) and the recent steps?",
    choices: MOMENTS,
  },
  {
    name: "consequence",
    type: "score" as const,
    instructions:
      "How consequential would a wrong next step be if the agent continues without an independent expert review?",
    levels: CONSEQUENCE_LEVELS,
  },
];

export interface Answer {
  readonly name: string;
  readonly type: string;
  readonly choice?: unknown;
  readonly score?: number;
  readonly probabilities?: ReadonlyArray<{ readonly value: unknown; readonly probability: number }>;
  readonly reason?: string;
}

export interface DecisionRequest {
  readonly model: ModelRef;
  readonly input: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly questions: typeof QUESTIONS;
}

export interface DecisionResult {
  readonly answers: readonly Answer[];
  readonly cost?: number;
}

export type GenerateDecisions = (request: DecisionRequest) => Promise<DecisionResult>;

export type AttemptOutcome = "ok" | "next" | "stop" | "timeout" | "skipped";

export interface Attempt {
  readonly model: string;
  readonly outcome: AttemptOutcome;
  readonly ms: number;
  readonly error?: string;
}

export type RouteResult =
  | {
      readonly ok: true;
      readonly model: string;
      readonly result: DecisionResult;
      readonly attempts: Attempt[];
    }
  | { readonly ok: false; readonly attempts: Attempt[] };

export const ATTEMPT_TIMEOUT_MS = 5_000;
export const TOTAL_TIMEOUT_MS = 10_000;
export const SKIP_MS = 60_000;

/**
 * Host error tags seen on 2.2.0 (spike S1). The host already retries rate limits, overload and
 * unsent requests, so a failure here moves to the next model or stops; it never retries.
 */
function classify(error: unknown): { action: "next" | "stop"; skip: boolean; tag: string } {
  const tag = (error as { _tag?: string } | undefined)?._tag ?? "unknown";
  const reason = (error as { reason?: string } | undefined)?.reason;
  if (tag === "Generate.ProviderRequestError") {
    if (reason === "invalid_request" || reason === "content_filter")
      return { action: "stop", skip: false, tag };
    return { action: "next", skip: reason === "rate_limit" || reason === "overloaded", tag };
  }
  if (
    tag === "Generate.ModelNotFoundError" ||
    tag === "Generate.UnsupportedModelError" ||
    tag === "Generate.UnavailableError"
  ) {
    return { action: "next", skip: false, tag };
  }
  return { action: "stop", skip: false, tag };
}

const TIMEOUT = Symbol("timeout");

function race<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  // A late rejection from an abandoned call must not surface as unhandled.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const answered = (result: DecisionResult) =>
  QUESTIONS.every((question) => result.answers.some((answer) => answer.name === question.name));

/**
 * Walks the configured models once and takes the first valid response. A model that was rate
 * limited, overloaded or timed out is skipped for `SKIP_MS`, so a throttled free model does not
 * stall every step while the host keeps retrying it.
 */
export function createRouter(generate: GenerateDecisions, now: () => number = Date.now) {
  const skipUntil = new Map<string, number>();
  return async (models: readonly ModelRef[], text: string): Promise<RouteResult> => {
    const attempts: Attempt[] = [];
    const deadline = now() + TOTAL_TIMEOUT_MS;
    for (const ref of models) {
      const model = modelKey(ref);
      if ((skipUntil.get(model) ?? 0) > now()) {
        attempts.push({ model, outcome: "skipped", ms: 0 });
        continue;
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const start = now();
      try {
        const result = await race(
          generate({ model: ref, input: [{ type: "text", text }], questions: QUESTIONS }),
          Math.min(ATTEMPT_TIMEOUT_MS, remaining),
        );
        if (result === TIMEOUT) {
          attempts.push({ model, outcome: "timeout", ms: now() - start });
          skipUntil.set(model, now() + SKIP_MS);
          continue;
        }
        if (!answered(result)) {
          attempts.push({ model, outcome: "stop", ms: now() - start, error: "missing answers" });
          return { ok: false, attempts };
        }
        attempts.push({ model, outcome: "ok", ms: now() - start });
        return { ok: true, model, result, attempts };
      } catch (error) {
        const { action, skip, tag } = classify(error);
        attempts.push({ model, outcome: action, ms: now() - start, error: tag });
        if (skip) skipUntil.set(model, now() + SKIP_MS);
        if (action === "stop") return { ok: false, attempts };
      }
    }
    return { ok: false, attempts };
  };
}
