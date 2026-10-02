import type { SessionID } from "./messages.js";

export interface OperationToken {
  readonly isCurrent: () => boolean;
  readonly release: () => void;
}

export interface OperationLifetime {
  readonly begin: (sessionID: SessionID) => OperationToken;
  readonly forget: (sessionID: SessionID) => void;
  readonly dispose: () => void;
}

export function createOperationLifetime(): OperationLifetime {
  const pending = new Map<SessionID, Set<OperationToken>>();
  let disposed = false;

  return {
    begin: (sessionID) => {
      if (disposed) return { isCurrent: () => false, release: () => {} };
      const bucket = pending.get(sessionID) ?? new Set<OperationToken>();
      pending.set(sessionID, bucket);
      const token: OperationToken = {
        isCurrent: () => bucket.has(token),
        release: () => {
          if (!bucket.delete(token)) return;
          if (bucket.size === 0 && pending.get(sessionID) === bucket) pending.delete(sessionID);
        },
      };
      bucket.add(token);
      return token;
    },
    forget: (sessionID) => {
      const bucket = pending.get(sessionID);
      if (bucket === undefined) return;
      pending.delete(sessionID);
      bucket.clear();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const bucket of pending.values()) bucket.clear();
      pending.clear();
    },
  };
}
