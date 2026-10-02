import type { CapturedHistory } from "./context.js";
import type { ModelReference } from "./messages.js";
import { turnKeyForHistory } from "./request.js";
import type { SerializedEntry } from "./serialize.js";
import type { RequestSnapshot } from "./snapshot-store.js";

export interface MergedConsultContext {
  readonly entries: readonly SerializedEntry[];
  readonly executorModel?: ModelReference;
}

export interface ConsultMergeInput {
  readonly snapshot?: RequestSnapshot;
  readonly history: CapturedHistory;
  readonly messageID: string;
}

export function mergeExplicitConsult(input: ConsultMergeInput): MergedConsultContext {
  const { snapshot, history, messageID } = input;
  const currentIndex = history.messageIDs.indexOf(messageID);
  const fresh =
    snapshot !== undefined && currentIndex >= 0 && snapshot.turnKey === turnKeyForHistory(history);
  const current = fresh ? snapshot : undefined;
  const entries = current
    ? [...current.entries, ...history.entries.slice(currentIndex)]
    : history.entries;
  const executorModel = history.executorModel ?? current?.executorModel;
  return {
    entries,
    ...(executorModel ? { executorModel } : {}),
  };
}
