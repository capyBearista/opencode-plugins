import type { EvaluationAnswer, EvaluationQuestions } from "@opencode/ai/experimental";
import { RouterError } from "./router.js";
import { CONSEQUENCE_ANCHORS, CONSEQUENCE_MAX, CONSEQUENCE_MIN } from "./routing-types.js";

export const ADVISOR_WOULD_HELP_QUESTION = "advisor_would_help";
export const CONSEQUENCE_QUESTION = "consequence";

export const ADVISOR_WOULD_HELP_INSTRUCTIONS =
  "Would independent expert review at this point materially improve correctness or catch an " +
  "important issue in the primary agent's next action?";

export const CONSEQUENCE_INSTRUCTIONS =
  "How consequential would an incorrect next action be if the Executor proceeds without " +
  "independent review? Answer with the level that best matches the rubric.";

export interface ZenAnswers {
  readonly advisorWouldHelp: number;
  readonly consequence: number;
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
  };
}

function normalizeScore(score: number): number {
  return Math.min(CONSEQUENCE_MAX, Math.max(CONSEQUENCE_MIN, Math.round(score)));
}
