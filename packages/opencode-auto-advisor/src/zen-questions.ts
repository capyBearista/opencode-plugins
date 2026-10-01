import type { EvaluationAnswer, EvaluationQuestions } from "@opencode/ai/experimental";
import { RouterError } from "./router.js";
import { CONSEQUENCE_ANCHORS, CONSEQUENCE_MAX, CONSEQUENCE_MIN } from "./routing-types.js";

export const ADVISOR_WOULD_HELP_QUESTION = "advisor_would_help";
export const CONSEQUENCE_QUESTION = "consequence";

export const ADVISOR_WOULD_HELP_INSTRUCTIONS =
  "Judge only the Executor's immediate pending action, not the overall difficulty of the project. " +
  "Answer true only when independent expert review has a meaningful chance of changing that next " +
  "action or catching a non-obvious correctness, security, data-integrity, concurrency, compatibility, " +
  "or design problem in it. Answer false for routine, mechanical, read-only, easily reversible, " +
  "already well-supported, or otherwise low-value-for-independent-review actions.";

export const CONSEQUENCE_INSTRUCTIONS =
  "How consequential would an incorrect next action be if the Executor proceeds without " +
  "independent review? Answer with the level that best matches the rubric.";

export interface ZenAnswers {
  readonly advisorWouldHelp: number;
  readonly consequence: number;
  readonly rawConsequence: number;
  readonly consequenceProbabilities?: Readonly<Record<string, number>>;
  readonly consequenceConfidence?: number;
}

export function buildZenQuestions(): EvaluationQuestions {
  return {
    [ADVISOR_WOULD_HELP_QUESTION]: {
      type: "boolean",
      instructions: ADVISOR_WOULD_HELP_INSTRUCTIONS,
    },
    [CONSEQUENCE_QUESTION]: {
      type: "score",
      instructions: CONSEQUENCE_INSTRUCTIONS,
      criteria: CONSEQUENCE_ANCHORS.map(
        (anchor) => `${anchor.level} (${anchor.summary}): ${anchor.guidance}`,
      ),
    },
  };
}

export function readZenAnswers(answers: Readonly<Record<string, EvaluationAnswer>>): ZenAnswers {
  const wouldHelp = answers[ADVISOR_WOULD_HELP_QUESTION];
  if (wouldHelp?.type !== "boolean") {
    throw new RouterError(`missing boolean answer for ${ADVISOR_WOULD_HELP_QUESTION}`);
  }
  const consequence = answers[CONSEQUENCE_QUESTION];
  if (consequence?.type !== "score") {
    throw new RouterError(`missing score answer for ${CONSEQUENCE_QUESTION}`);
  }
  return {
    advisorWouldHelp: wouldHelp.probability,
    consequence: normalizeScore(consequence.score),
    rawConsequence: consequence.score,
    ...(consequence.probabilities ? { consequenceProbabilities: consequence.probabilities } : {}),
    ...(consequence.confidence !== undefined
      ? { consequenceConfidence: consequence.confidence }
      : {}),
  };
}

function normalizeScore(score: number): number {
  return Math.min(CONSEQUENCE_MAX, Math.max(CONSEQUENCE_MIN, Math.round(score)));
}
