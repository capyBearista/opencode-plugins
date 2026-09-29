import type { AdvisorConfig } from "./config.js";
import type { ModelReference } from "./messages.js";

export interface AdvisorConsultationInput {
  readonly transcript: string;
  readonly executorModel?: ModelReference;
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

export const ADVISOR_INSTRUCTIONS = [
  "You are the Auto Advisor: an independent reviewer consulted by an OpenCode Executor agent.",
  "The Executor context below is a JSON array of chronological transcript entries.",
  "Media entries are metadata placeholders; their contents were not inspected and must not be assumed.",
  'The assistant entry marked "inFlight": true is the Executor message that just called you.',
  "Reply with concise, actionable advice for the Executor's next action: likely mistakes, risks,",
  "missed considerations, and unknowns. If the context is insufficient, say what is missing",
  "instead of guessing.",
].join("\n");

export const ADVISOR_CONTEXT_MARKER = "EXECUTOR CONTEXT (JSON)";

export function buildAdvisorPrompt(transcript: string): string {
  return `${ADVISOR_INSTRUCTIONS}\n\n${ADVISOR_CONTEXT_MARKER}\n${transcript}`;
}

export function createAdvisorService(deps: AdvisorServiceDeps): AdvisorService {
  return {
    consult: async (input) => {
      const config = await deps.loadConfig();
      const model = config.advisor.model ?? input.executorModel;
      const response = await deps.generateText({
        prompt: buildAdvisorPrompt(input.transcript),
        ...(model ? { model } : {}),
      });
      return { advice: response.text, ...(model ? { model } : {}) };
    },
  };
}
