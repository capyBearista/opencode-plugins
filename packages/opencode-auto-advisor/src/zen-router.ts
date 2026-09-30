import type { EvaluationQuestions, EvaluationResponseFor } from "@opencode/ai/experimental";
import type { AdvisorConfig } from "./config.js";
import { RouterError } from "./router.js";
import type { AdvisorRouter, RouterAssessment, RoutingState } from "./routing-types.js";
import { serializeAdvisorContext } from "./serialize.js";
import { classifyZenFailure, type ZenFailure } from "./zen-errors.js";
import { buildZenQuestions, readZenAnswers } from "./zen-questions.js";

export const MAX_ATTEMPTS_PER_MODEL = 2;
export const RETRY_BACKOFF_MS = 250;

export interface ZenEvaluationSeam {
  readonly evaluate: (input: {
    readonly modelID: string;
    readonly state: string;
    readonly questions: EvaluationQuestions;
  }) => Promise<EvaluationResponseFor<EvaluationQuestions>>;
}

export interface ZenRouterDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly evaluation: ZenEvaluationSeam;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createZenRouter(deps: ZenRouterDeps): AdvisorRouter {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    evaluate: async (state: RoutingState): Promise<RouterAssessment> => {
      const config = await deps.loadConfig();
      const models = config.routing.models;
      if (models.length === 0) {
        throw new RouterError("routing.models is empty", { errorClass: "InvalidRequest" });
      }
      const questions = buildZenQuestions();
      const transcript = serializeAdvisorContext(state.entries);
      const started = Date.now();
      let attempts = 0;
      let lastModel = models[0];
      let lastFailure: ZenFailure = { disposition: "terminal", errorClass: "UnknownError" };

      for (const modelID of models) {
        lastModel = modelID;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
          attempts += 1;
          try {
            const response = await deps.evaluation.evaluate({
              modelID,
              state: transcript,
              questions,
            });
            const answers = readZenAnswers(response.answers);
            return {
              advisorWouldHelp: answers.advisorWouldHelp,
              consequence: answers.consequence,
              metadata: {
                model: modelID,
                providerModel: response.model,
                attempts,
                latencyMs: Date.now() - started,
              },
            };
          } catch (cause) {
            if (cause instanceof RouterError) {
              throw new RouterError(cause.message, {
                errorClass: "InvalidProviderOutput",
                model: modelID,
                attempts,
              });
            }
            lastFailure = classifyZenFailure(cause);
            if (lastFailure.disposition === "terminal") {
              throw chainFailure(lastModel, lastFailure, attempts);
            }
            if (lastFailure.disposition === "retry" && attempt < MAX_ATTEMPTS_PER_MODEL) {
              await sleep(RETRY_BACKOFF_MS * attempt);
              continue;
            }
            break;
          }
        }
      }
      throw chainFailure(lastModel, lastFailure, attempts);
    },
  };
}

function chainFailure(model: string, failure: ZenFailure, attempts: number): RouterError {
  return new RouterError(
    `zen routing failed on ${model} (${failure.errorClass}) after ${attempts} attempt(s)`,
    { errorClass: failure.errorClass, model, attempts },
  );
}
