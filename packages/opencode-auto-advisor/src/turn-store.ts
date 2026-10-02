import type { SessionID } from "./messages.js";
import { DEFAULT_MAX_SESSIONS } from "./snapshot-store.js";

export interface TurnState {
  readonly userMessageID: string;
  fingerprint?: string;
  consumed: number;
}

export interface TurnStore {
  readonly turnFor: (sessionID: SessionID, userMessageID: string) => TurnState;
  readonly forget: (sessionID: SessionID) => void;
}

export function createTurnStore(options: { readonly maxSessions?: number } = {}): TurnStore {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const turns = new Map<SessionID, TurnState>();

  return {
    turnFor: (sessionID, userMessageID) => {
      const existing = turns.get(sessionID);
      if (existing && existing.userMessageID === userMessageID) {
        turns.delete(sessionID);
        turns.set(sessionID, existing);
        return existing;
      }
      const next: TurnState = { userMessageID, consumed: 0 };
      turns.delete(sessionID);
      turns.set(sessionID, next);
      while (turns.size > maxSessions) {
        const oldest = turns.keys().next().value;
        if (oldest === undefined) break;
        turns.delete(oldest);
      }
      return next;
    },
    forget: (sessionID) => {
      turns.delete(sessionID);
    },
  };
}
