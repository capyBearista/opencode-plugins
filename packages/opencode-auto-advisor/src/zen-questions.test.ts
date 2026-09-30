import { describe, expect, test } from "bun:test";
import type { EvaluationAnswer } from "@opencode/ai/experimental";
import { RouterError } from "./router.js";
import { CONSEQUENCE_ANCHORS } from "./routing-types.js";
import {
  ADVISOR_WOULD_HELP_INSTRUCTIONS,
  ADVISOR_WOULD_HELP_QUESTION,
  buildZenQuestions,
  CONSEQUENCE_INSTRUCTIONS,
  CONSEQUENCE_QUESTION,
  readZenAnswers,
} from "./zen-questions.js";

describe("zen questions", () => {
  test("asks exactly the boolean help question and the five-level consequence rubric", () => {
    const questions = buildZenQuestions();
    expect(Object.keys(questions)).toEqual([ADVISOR_WOULD_HELP_QUESTION, CONSEQUENCE_QUESTION]);

    const help = questions[ADVISOR_WOULD_HELP_QUESTION];
    expect(help?.type).toBe("boolean");
    expect(help?.instructions).toBe(ADVISOR_WOULD_HELP_INSTRUCTIONS);

    const consequence = questions[CONSEQUENCE_QUESTION];
    expect(consequence?.type).toBe("score");
    expect(consequence?.instructions).toBe(CONSEQUENCE_INSTRUCTIONS);
    if (consequence?.type !== "score") throw new Error("expected a score question");
    expect(consequence.criteria).toHaveLength(5);
    for (const [index, anchor] of CONSEQUENCE_ANCHORS.entries()) {
      expect(consequence.criteria[index]).toContain(String(anchor.level));
      expect(consequence.criteria[index]).toContain(anchor.summary);
      expect(consequence.criteria[index]).toContain(anchor.guidance);
    }
  });

  test("reads the normalized boolean probability and integer score", () => {
    const answers: Record<string, EvaluationAnswer> = {
      [ADVISOR_WOULD_HELP_QUESTION]: { type: "boolean", probability: 0.82 },
      [CONSEQUENCE_QUESTION]: { type: "score", score: 3 },
    };
    expect(readZenAnswers(answers)).toEqual({ advisorWouldHelp: 0.82, consequence: 3 });
  });

  test("rounds continuous System One scores onto the discrete 0-4 rubric", () => {
    const score = (value: number): Record<string, EvaluationAnswer> => ({
      [ADVISOR_WOULD_HELP_QUESTION]: { type: "boolean", probability: 0.5 },
      [CONSEQUENCE_QUESTION]: { type: "score", score: value },
    });
    expect(readZenAnswers(score(2.4)).consequence).toBe(2);
    expect(readZenAnswers(score(2.5)).consequence).toBe(3);
    expect(readZenAnswers(score(0.2)).consequence).toBe(0);
    expect(readZenAnswers(score(3.7)).consequence).toBe(4);
  });

  test("rejects mismatched answer shapes as router errors", () => {
    expect(() =>
      readZenAnswers({
        [ADVISOR_WOULD_HELP_QUESTION]: { type: "score", score: 1 },
        [CONSEQUENCE_QUESTION]: { type: "score", score: 3 },
      }),
    ).toThrow(RouterError);
    expect(() =>
      readZenAnswers({
        [ADVISOR_WOULD_HELP_QUESTION]: { type: "boolean", probability: 0.5 },
      }),
    ).toThrow(RouterError);
  });
});
