import { AIError, TimeoutError } from "@opencode/ai";
import type { EvaluationQuestions, EvaluationResponseFor } from "@opencode/ai/experimental";
import { Evaluation, EvaluationClient } from "@opencode/ai/experimental";
import { SystemOne } from "@opencode/ai/experimental/system-one";
import { make } from "@opencode/ai/promise";
import { resolveZenAuth, type ZenConnectionDomain } from "./zen-auth.js";

export const ZEN_PROVIDER_ID = "opencode";
export const ZEN_PROVIDER_METADATA_KEY = "opencode";
export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const ZEN_CALL_TIMEOUT_MS = 30_000;

export interface ZenEvaluationInput {
  readonly modelID: string;
  readonly state: string;
  readonly questions: EvaluationQuestions;
}

export interface ZenEvaluationOptions {
  readonly connection?: ZenConnectionDomain;
  readonly baseURL?: string;
  readonly timeoutMs?: number;
}

export interface ZenEvaluation {
  readonly evaluate: (
    input: ZenEvaluationInput,
  ) => Promise<EvaluationResponseFor<EvaluationQuestions>>;
  readonly dispose: () => Promise<void>;
}

export function createZenEvaluation(options: ZenEvaluationOptions = {}): ZenEvaluation {
  const timeoutMs = options.timeoutMs ?? ZEN_CALL_TIMEOUT_MS;
  const runner = make({ layer: EvaluationClient.fetchLayer });
  type RunnerEffect<A, E> = Parameters<typeof runner.run<A, E>>[0];
  let disposed = false;

  return {
    evaluate: async (input) => {
      if (disposed) throw new Error("zen evaluation runtime disposed");
      const model = SystemOne.model({
        id: input.modelID,
        provider: ZEN_PROVIDER_ID,
        providerMetadataKey: ZEN_PROVIDER_METADATA_KEY,
        auth: await resolveZenAuth(options.connection),
        baseURL: options.baseURL ?? ZEN_BASE_URL,
      });
      const request = Evaluation.request({
        model,
        state: input.state,
        questions: input.questions,
      });
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            new AIError({
              reason: new TimeoutError({
                message: `zen evaluation exceeded ${timeoutMs}ms`,
              }),
            }),
          ),
        timeoutMs,
      );
      try {
        return await runner.run(
          Evaluation.run(request) as unknown as RunnerEffect<
            EvaluationResponseFor<EvaluationQuestions>,
            AIError
          >,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await runner.dispose();
    },
  };
}
