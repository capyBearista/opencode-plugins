import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { AdviceHistory, AdviceRecord } from "./advice-history.js";
import { absorbedReviewIDs, formatCompactionReviews } from "./advice-history-format.js";
import { type EligibilitySources, evaluateAdvisorEligibility } from "./eligibility.js";
import type { SessionID } from "./messages.js";
import { createOperationLifetime } from "./operation-lifetime.js";

export const COMPACTION_HOOK = "compaction";

const ABSORBED_SESSION_CAP = 64;
const EMPTY_IDS: ReadonlySet<string> = new Set();

type CompactionSession = Pick<PluginContext["session"], "hook"> &
  Partial<Pick<PluginContext["session"], "get">>;

export interface AdviceCompactionDeps {
  readonly history: AdviceHistory;
  readonly eligibility: EligibilitySources;
}

export interface AdviceCompactionRegistration {
  readonly invalidate: () => void;
  readonly dispose: () => Promise<void>;
  readonly forget: (sessionID: SessionID) => void;
  readonly absorbed: (sessionID: SessionID) => ReadonlySet<string>;
  readonly ended: (sessionID: SessionID, text: string) => void;
  readonly failed: (sessionID: SessionID) => void;
}

interface PendingCompaction {
  readonly token: string;
  readonly records: readonly AdviceRecord[];
}

export interface CompactionEndedEvent {
  readonly sessionID: SessionID;
  readonly text: string;
}

export async function registerAdviceCompaction(
  session: CompactionSession,
  deps: AdviceCompactionDeps,
): Promise<AdviceCompactionRegistration> {
  const pending = new Map<SessionID, PendingCompaction>();
  const absorbed = new Map<SessionID, Set<string>>();
  const lifetime = createOperationLifetime();

  const registration = await session.hook(COMPACTION_HOOK, async (event) => {
    const sessionID = readString(event, "sessionID");
    if (sessionID === undefined) return;
    const agentID = readString(event, "agent");
    const token = lifetime.begin(sessionID as SessionID);
    try {
      if (!token.isCurrent()) return;
      const admission = await evaluateAdvisorEligibility(deps.eligibility, {
        sessionID,
        ...(agentID ? { agentID } : {}),
      });
      if (!token.isCurrent()) return;
      if (!admission.eligible) return;

      let records: readonly AdviceRecord[];
      try {
        records = await deps.history.get(sessionID as SessionID);
      } catch {
        return;
      }
      if (!token.isCurrent()) return;
      if (records.length === 0) return;
      const block = formatCompactionReviews(records);
      if (block.length === 0) return;

      pending.set(sessionID as SessionID, { token: crypto.randomUUID(), records });
      pushSystemPart(event, block);
      extendResult(event, block);
    } finally {
      token.release();
    }
  });

  let disposed = false;
  const invalidate = (): void => {
    lifetime.dispose();
  };
  return {
    invalidate,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      invalidate();
      pending.clear();
      absorbed.clear();
      await registration.dispose();
    },
    forget: (sessionID) => {
      lifetime.forget(sessionID);
      pending.delete(sessionID);
      absorbed.delete(sessionID);
    },
    absorbed: (sessionID) => absorbed.get(sessionID) ?? EMPTY_IDS,
    ended: (sessionID, text) => {
      const entry = pending.get(sessionID);
      if (entry === undefined) return;
      pending.delete(sessionID);
      const ids = absorbedReviewIDs(text, entry.records);
      if (ids.length === 0) return;
      const current = absorbed.get(sessionID) ?? new Set<string>();
      for (const id of ids) current.add(id);
      absorbed.delete(sessionID);
      absorbed.set(sessionID, current);
      while (absorbed.size > ABSORBED_SESSION_CAP) {
        const oldest = absorbed.keys().next().value;
        if (oldest === undefined) break;
        absorbed.delete(oldest);
      }
      void deps.history.retire(sessionID, ids).catch(() => undefined);
    },
    failed: (sessionID) => {
      lifetime.forget(sessionID);
      pending.delete(sessionID);
    },
  };
}

export function readCompactionEndedEvent(payload: unknown): CompactionEndedEvent | undefined {
  if (!isRecord(payload) || payload.type !== "session.compaction.ended") return undefined;
  const data = payload.data;
  if (!isRecord(data) || typeof data.sessionID !== "string" || typeof data.text !== "string") {
    return undefined;
  }
  return { sessionID: data.sessionID as SessionID, text: data.text };
}

export function readCompactionFailedEvent(payload: unknown): SessionID | undefined {
  if (!isRecord(payload) || payload.type !== "session.compaction.failed") return undefined;
  const data = payload.data;
  if (!isRecord(data) || typeof data.sessionID !== "string") return undefined;
  return data.sessionID as SessionID;
}

function pushSystemPart(event: object, block: string): void {
  const system = (event as { readonly system?: unknown }).system;
  if (!Array.isArray(system)) return;
  try {
    system.push({ type: "text", text: block });
  } catch {
    return;
  }
}

function extendResult(event: object, block: string): void {
  const result = (event as { result?: unknown }).result;
  if (!isRecord(result) || typeof result.summary !== "string") return;
  if (result.summary.includes(block)) return;
  const summary = result.summary.length > 0 ? `${result.summary}\n\n${block}` : block;
  try {
    (event as { result?: unknown }).result = { ...result, summary };
  } catch {
    return;
  }
}

function readString(value: object, key: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
