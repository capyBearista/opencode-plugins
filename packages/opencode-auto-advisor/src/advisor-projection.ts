import { buildAdvisorPrompt } from "./advisor-service.js";
import type { CanonicalState } from "./canonical.js";
import { type SerializedEntry, serializeAdvisorContext, stableStringify } from "./serialize.js";

export const ADVISOR_OMISSION_MARKER =
  "Executor context was omitted to fit the Advisor model's context budget.";

export interface AdvisorContextDiagnostics {
  readonly complete: boolean;
  readonly omittedEntries: number;
  readonly includedEntries: number;
  readonly estimatedTokens: number;
  readonly inputBudget: number;
}

export interface AdvisorProjection {
  readonly transcript: string;
  readonly diagnostics?: AdvisorContextDiagnostics;
}

export interface AdvisorProjectionOptions {
  readonly inputBudget?: number;
}

export type AdvisorProjectionBuilder = (
  state: CanonicalState,
  options?: AdvisorProjectionOptions,
) => AdvisorProjection;

export function estimateTokens(text: string): number {
  return estimateChars(text.length);
}

export function buildAdvisorProjection(
  state: CanonicalState,
  options: AdvisorProjectionOptions = {},
): AdvisorProjection {
  const eligible = withoutReasoning(state);
  const inputBudget = options.inputBudget;
  if (inputBudget === undefined) return { transcript: serializeAdvisorContext(eligible) };
  if (!Number.isFinite(inputBudget) || inputBudget <= 0) {
    throw new RangeError(
      `Advisor projection input budget must be a finite positive number, received ${String(inputBudget)}`,
    );
  }

  const envelopeChars = buildAdvisorPrompt("").length;
  const fullTranscript = serializeAdvisorContext(eligible);
  if (estimateChars(envelopeChars + fullTranscript.length) <= inputBudget) {
    return withDiagnostics(fullTranscript, eligible.length, 0, inputBudget);
  }

  const marker = omissionMarker();
  const markerTranscriptChars = stableStringify(marker).length + 2;
  if (estimateChars(envelopeChars + markerTranscriptChars) > inputBudget) {
    throw new RangeError(
      state.length === 0
        ? `Advisor projection input budget ${inputBudget} cannot fit the mandatory Advisor prompt framing`
        : `Advisor projection input budget ${inputBudget} cannot fit the Advisor prompt with the required omission marker`,
    );
  }

  const flags = select(eligible, envelopeChars, inputBudget, markerTranscriptChars);
  const included = eligible.filter((_, index) => flags[index] === true);
  const transcript = serializeAdvisorContext([marker, ...included]);
  return withDiagnostics(
    transcript,
    included.length,
    eligible.length - included.length,
    inputBudget,
  );
}

function withoutReasoning(state: CanonicalState): CanonicalState {
  return state.map((entry) => {
    if (!("blocks" in entry)) return entry;
    const blocks = entry.blocks.filter((block) => block.type !== "reasoning");
    return blocks.length === entry.blocks.length ? entry : { ...entry, blocks };
  });
}

function withDiagnostics(
  transcript: string,
  includedEntries: number,
  omittedEntries: number,
  inputBudget: number,
): AdvisorProjection {
  return {
    transcript,
    diagnostics: {
      complete: omittedEntries === 0,
      omittedEntries,
      includedEntries,
      estimatedTokens: estimateTokens(buildAdvisorPrompt(transcript)),
      inputBudget,
    },
  };
}

function omissionMarker(): SerializedEntry {
  return { role: "marker", type: "context-omitted", detail: ADVISOR_OMISSION_MARKER };
}

function select(
  state: CanonicalState,
  envelopeChars: number,
  budget: number,
  markerTranscriptChars: number,
): readonly boolean[] {
  const flags = state.map(() => false);
  let transcriptChars = markerTranscriptChars;
  for (const tier of priorityTiers(state)) {
    for (const index of tier) {
      const entry = state[index];
      if (entry === undefined) continue;
      const candidateChars = transcriptChars + stableStringify(entry).length + 1;
      if (estimateChars(envelopeChars + candidateChars) > budget) continue;
      flags[index] = true;
      transcriptChars = candidateChars;
    }
  }
  return flags;
}

function estimateChars(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

function priorityTiers(state: CanonicalState): readonly (readonly number[])[] {
  const system: number[] = [];
  const currentUser: number[] = [];
  const currentState: number[] = [];
  const compactions: number[] = [];
  const history: number[] = [];
  const currentStart = currentSegmentStart(state);
  for (let index = 0; index < state.length; index += 1) {
    const role = state[index]?.role;
    if (role === "system") system.push(index);
    if (role === "compaction") compactions.push(index);
  }
  if (currentStart >= 0) {
    if (state[currentStart]?.role === "user") {
      currentUser.push(currentStart);
      for (let index = currentStart + 1; index < state.length; index += 1) {
        const role = state[index]?.role;
        if (role !== "system" && role !== "compaction") currentState.push(index);
      }
    } else {
      for (let index = currentStart; index < state.length; index += 1) {
        const role = state[index]?.role;
        if (role !== "system" && role !== "compaction") currentState.push(index);
      }
    }
  }
  const historyStart = currentStart >= 0 ? currentStart : state.length;
  for (let index = historyStart - 1; index >= 0; index -= 1) {
    const role = state[index]?.role;
    if (role !== "system" && role !== "compaction") history.push(index);
  }
  return [system, currentUser, currentState, compactions, history];
}

function currentSegmentStart(state: CanonicalState): number {
  for (let index = state.length - 1; index >= 0; index -= 1) {
    if (state[index]?.role === "user") return index;
  }
  for (let index = state.length - 1; index >= 0; index -= 1) {
    if (state[index]?.role === "assistant") return index;
  }
  return -1;
}
