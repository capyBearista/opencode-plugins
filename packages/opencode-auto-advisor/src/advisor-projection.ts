import { buildAdvisorPrompt } from "./advisor-service.js";
import type { CanonicalState } from "./canonical.js";
import { type SerializedEntry, serializeAdvisorContext, stableStringify } from "./serialize.js";

export const ADVISOR_OMISSION_MARKER =
  "Earlier or lower-priority Executor context was omitted to fit the Advisor model's context budget.";

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
  const inputBudget = options.inputBudget;
  if (inputBudget === undefined) return { transcript: serializeAdvisorContext(state) };

  const envelope = buildAdvisorPrompt("").length;
  const selection = select(state, envelope, inputBudget);
  const included = state.filter((_, index) => selection.flags[index] === true);
  const omitted = state.length - included.length;
  const transcript = serializeAdvisorContext(
    omitted > 0 ? [omissionMarker(), ...included] : included,
  );
  return {
    transcript,
    diagnostics: {
      complete: omitted === 0,
      omittedEntries: omitted,
      includedEntries: included.length,
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
): { readonly flags: readonly boolean[]; readonly omitted: number } {
  const flags = state.map(() => false);
  let chars = 2;
  let count = 0;
  for (const tier of priorityTiers(state)) {
    let complete = true;
    for (const index of tier) {
      const entry = state[index];
      if (entry === undefined) continue;
      const entryChars = stableStringify(entry).length + (count > 0 ? 1 : 0);
      if (estimateChars(envelopeChars + chars + entryChars) > budget) {
        complete = false;
        continue;
      }
      flags[index] = true;
      chars += entryChars;
      count += 1;
    }
    if (!complete) break;
  }
  return { flags, omitted: state.length - count };
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
