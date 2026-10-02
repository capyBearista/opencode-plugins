import type {
  EvaluationInput,
  EvaluationQuestions,
  EvaluationResponseFor,
} from "@opencode/ai/experimental";
import type { AdvisorConfig } from "./config.js";
import { buildJevRoutingProjection } from "./jev-projection.js";
import type { SessionID } from "./messages.js";
import { RouterError } from "./router.js";
import type { AdvisorRouter, RouterAssessment, RoutingState } from "./routing-types.js";
import { DEFAULT_MAX_SESSIONS } from "./snapshot-store.js";
import { classifyZenFailure, type ZenFailure } from "./zen-errors.js";
import { buildZenQuestions, readZenAnswers } from "./zen-questions.js";

export const MAX_ATTEMPTS_PER_MODEL = 2;
export const RETRY_BACKOFF_MS = 250;
export const INELIGIBLE_ERROR_CLASS = "Authentication";

export interface ZenEvaluationSeam {
  readonly evaluate: (input: {
    readonly modelID: string;
    readonly state: EvaluationInput;
    readonly questions: EvaluationQuestions;
  }) => Promise<EvaluationResponseFor<EvaluationQuestions>>;
  readonly isPublicAuth?: () => Promise<boolean>;
}

export interface ZenRouterDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly evaluation: ZenEvaluationSeam;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createZenRouter(deps: ZenRouterDeps): AdvisorRouter {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ineligible = createIneligibilityCache();

  return {
    evaluate: async (state: RoutingState): Promise<RouterAssessment> => {
      const config = await deps.loadConfig();
      const models = config.routing.models;
      if (models.length === 0) {
        throw new RouterError("routing.models is empty", { errorClass: "InvalidRequest" });
      }
      const questions = buildZenQuestions();
      const projection = buildJevRoutingProjection(state.entries);
      const started = Date.now();
      let attempts = 0;
      let lastModel = models[0];
      let lastFailure: ZenFailure = { disposition: "terminal", errorClass: "UnknownError" };
      let lastSkipped = false;

      for (const modelID of models) {
        lastModel = modelID;
        if (ineligible.has(state.sessionID, modelID)) {
          lastFailure = { disposition: "terminal", errorClass: INELIGIBLE_ERROR_CLASS };
          lastSkipped = true;
          continue;
        }
        for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
          attempts += 1;
          try {
            const response = await deps.evaluation.evaluate({
              modelID,
              state: projection,
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
                rawConsequence: answers.rawConsequence,
                ...(answers.consequenceProbabilities
                  ? { consequenceProbabilities: answers.consequenceProbabilities }
                  : {}),
                ...(answers.consequenceConfidence !== undefined
                  ? { consequenceConfidence: answers.consequenceConfidence }
                  : {}),
              },
            };
          } catch (cause) {
            if (cause instanceof RouterError) {
              throw new RouterError(cause.message, {
                errorClass: "InvalidProviderOutput",
                model: modelID,
                attempts,
                disposition: "terminal",
              });
            }
            lastFailure = classifyZenFailure(cause);
            lastSkipped = false;
            if (lastFailure.disposition === "fallback") break;
            if (lastFailure.disposition === "terminal") {
              await rememberIneligible(
                deps.evaluation,
                ineligible,
                state.sessionID,
                modelID,
                lastFailure,
              );
              throw chainFailure(lastModel, lastFailure, attempts);
            }
            if (attempt < MAX_ATTEMPTS_PER_MODEL) {
              await sleep(RETRY_BACKOFF_MS * attempt);
              continue;
            }
            throw chainFailure(lastModel, lastFailure, attempts);
          }
        }
      }
      throw lastSkipped
        ? skippedFailure(lastModel, lastFailure)
        : chainFailure(lastModel, lastFailure, attempts, "terminal");
    },
    forget: (sessionID) => {
      ineligible.forget(sessionID);
    },
  };
}

interface IneligibilityCache {
  readonly has: (sessionID: SessionID, modelID: string) => boolean;
  readonly add: (sessionID: SessionID, modelID: string) => void;
  readonly forget: (sessionID: SessionID) => void;
}

function createIneligibilityCache(): IneligibilityCache {
  const sessions = new Map<SessionID, Set<string>>();
  return {
    has: (sessionID, modelID) => sessions.get(sessionID)?.has(modelID) ?? false,
    add: (sessionID, modelID) => {
      const models = sessions.get(sessionID) ?? new Set<string>();
      sessions.delete(sessionID);
      sessions.set(sessionID, models);
      models.add(modelID);
      while (sessions.size > DEFAULT_MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    },
    forget: (sessionID) => {
      sessions.delete(sessionID);
    },
  };
}

async function rememberIneligible(
  evaluation: ZenEvaluationSeam,
  cache: IneligibilityCache,
  sessionID: SessionID,
  modelID: string,
  failure: ZenFailure,
): Promise<void> {
  if (failure.errorClass !== INELIGIBLE_ERROR_CLASS) return;
  try {
    if ((await evaluation.isPublicAuth?.()) !== true) return;
  } catch {
    return;
  }
  cache.add(sessionID, modelID);
}

function chainFailure(
  model: string,
  failure: ZenFailure,
  attempts: number,
  disposition: ZenFailure["disposition"] = failure.disposition,
): RouterError {
  return new RouterError(
    `zen routing failed on ${model} (${failure.errorClass}) after ${attempts} attempt(s)`,
    {
      errorClass: failure.errorClass,
      model,
      attempts,
      disposition,
    },
  );
}

function skippedFailure(model: string, failure: ZenFailure): RouterError {
  return new RouterError(
    `zen routing skipped ${model} (${failure.errorClass}): model is ineligible on the public token`,
    {
      errorClass: failure.errorClass,
      model,
      attempts: 0,
      disposition: "terminal",
    },
  );
}
