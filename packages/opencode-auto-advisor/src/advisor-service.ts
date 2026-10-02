import { buildAdvisorPrompt } from "./advisor-prompts.js";
import type { AdvisorConfig } from "./config.js";
import { DEFAULT_ADVISOR_TIMEOUT_MS } from "./config-types.js";
import type { ModelReference } from "./messages.js";

export {
  ADVISOR_CONTEXT_MARKER,
  ADVISOR_INSTRUCTIONS,
  buildAdvisorPrompt,
} from "./advisor-prompts.js";

export interface AdvisorConsultationInput {
  readonly transcript: string;
  readonly executorModel?: ModelReference;
  readonly advisorModel?: ModelReference;
  readonly onStart?: () => void;
  readonly isCurrent?: () => boolean;
}

export interface AdvisorConsultationResult {
  readonly advice: string;
  readonly model?: ModelReference;
}

export interface AdvisorService {
  readonly consult: (input: AdvisorConsultationInput) => Promise<AdvisorConsultationResult>;
}

export interface AdvisorServiceDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly generateText: (input: {
    readonly prompt: string;
    readonly model?: ModelReference;
  }) => Promise<{ readonly text: string }>;
}

export class AdvisorTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Advisor consultation timed out after ${timeoutMs}ms`);
    this.name = "AdvisorTimeoutError";
  }
}

export class AdvisorInvalidatedError extends Error {
  constructor() {
    super("advisor consultation invalidated by session deletion or plugin disposal");
    this.name = "AdvisorInvalidatedError";
  }
}

export function resolveAdvisorModel(
  config: AdvisorConfig,
  executorModel?: ModelReference,
): ModelReference | undefined {
  return config.advisor.model ?? executorModel;
}

export function createAdvisorService(deps: AdvisorServiceDeps): AdvisorService {
  return {
    consult: async (input) => {
      const isCurrent = input.isCurrent ?? (() => true);
      const config = await deps.loadConfig();
      if (!isCurrent()) throw new AdvisorInvalidatedError();
      const model = input.advisorModel ?? resolveAdvisorModel(config, input.executorModel);
      const timeoutMs = config.advisor.timeoutMs ?? DEFAULT_ADVISOR_TIMEOUT_MS;
      const prompt = buildAdvisorPrompt(input.transcript);
      invokeStart(input.onStart);
      if (!isCurrent()) throw new AdvisorInvalidatedError();
      const response = await withDeadline(
        deps.generateText({
          prompt,
          ...(model ? { model } : {}),
        }),
        timeoutMs,
      );
      if (!isCurrent()) throw new AdvisorInvalidatedError();
      return { advice: response.text, ...(model ? { model } : {}) };
    },
  };
}

function invokeStart(onStart: (() => void) | undefined): void {
  if (onStart === undefined) return;
  try {
    onStart();
  } catch {
    return;
  }
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AdvisorTimeoutError(timeoutMs));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
