import { type ModelRef, modelKey } from "./config.js";
import { createWalker, type WalkResult } from "./fallback.js";

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

export type RouteResult = WalkResult<DecisionResult>;

export const ATTEMPT_TIMEOUT_MS = 5_000;
export const TOTAL_TIMEOUT_MS = 10_000;

const answered = (result: DecisionResult) =>
  QUESTIONS.every((question) => result.answers.some((answer) => answer.name === question.name));

/**
 * Walks the configured Decision models once and takes the first complete response. An
 * incomplete one stops the walk: the questions, not the model, are the likely cause.
 */
export function createRouter(generate: GenerateDecisions, now: () => number = Date.now) {
  const walk = createWalker(now);
  return (models: readonly ModelRef[], text: string): Promise<RouteResult> =>
    walk({
      entries: models,
      key: modelKey,
      attemptMs: ATTEMPT_TIMEOUT_MS,
      totalMs: TOTAL_TIMEOUT_MS,
      call: async (model) => {
        const result = await generate({
          model,
          input: [{ type: "text", text }],
          questions: QUESTIONS,
        });
        if (!answered(result)) throw { _tag: "Decision.MissingAnswers" };
        return result;
      },
    });
}
