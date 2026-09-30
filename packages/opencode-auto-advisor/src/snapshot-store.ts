import type { ModelReference, SessionID } from "./messages.js";
import type { SerializedEntry } from "./serialize.js";

export interface RequestSnapshot {
  readonly sessionID: SessionID;
  readonly turnKey: string;
  readonly entries: readonly SerializedEntry[];
  readonly executorModel: ModelReference;
}

export interface SnapshotStore {
  readonly capture: (snapshot: RequestSnapshot) => void;
  readonly read: (sessionID: SessionID, turnKey: string) => RequestSnapshot | undefined;
  readonly forget: (sessionID: SessionID) => void;
  readonly sessions: () => number;
}

export const DEFAULT_MAX_SESSIONS = 64;

export function createSnapshotStore(
  options: { readonly maxSessions?: number } = {},
): SnapshotStore {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const snapshots = new Map<SessionID, RequestSnapshot>();

  const capture = (snapshot: RequestSnapshot): void => {
    snapshots.delete(snapshot.sessionID);
    snapshots.set(snapshot.sessionID, snapshot);
    while (snapshots.size > maxSessions) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
  };

  return {
    capture,
    read: (sessionID, turnKey) => {
      const snapshot = snapshots.get(sessionID);
      if (!snapshot || snapshot.turnKey !== turnKey) return undefined;
      snapshots.delete(sessionID);
      snapshots.set(sessionID, snapshot);
      return snapshot;
    },
    forget: (sessionID) => {
      snapshots.delete(sessionID);
    },
    sessions: () => snapshots.size,
  };
}
