import { Message } from "@opencode/ai";
import type { AssembledMessage, SessionID } from "./messages.js";

export const DEFAULT_MAX_ADVICE_SESSIONS = 64;
export const ADVISOR_DELIVERY_PREFIX = "[Auto Advisor automatic advice]";

export function advisorAdviceText(advice: string): string {
  return `${ADVISOR_DELIVERY_PREFIX}\n${advice}`;
}

export interface AdviceDeliveryInput {
  readonly messages: AssembledMessage[];
  readonly advice: string;
}

export function deliverAdvice(input: AdviceDeliveryInput): void {
  input.messages.push(Message.system(advisorAdviceText(input.advice)));
}

export interface LiveAdvice {
  readonly turnKey: string;
  readonly text: string;
}

export interface AdviceLifetime {
  readonly current: (sessionID: SessionID) => LiveAdvice | undefined;
  readonly activate: (sessionID: SessionID, turnKey: string, text: string) => void;
  readonly expire: (sessionID: SessionID, turnKey: string) => void;
  readonly forget: (sessionID: SessionID) => void;
  readonly sessions: () => number;
}

export function createAdviceLifetime(
  options: { readonly maxSessions?: number } = {},
): AdviceLifetime {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_ADVICE_SESSIONS;
  const live = new Map<SessionID, LiveAdvice>();

  return {
    current: (sessionID) => live.get(sessionID),
    activate: (sessionID, turnKey, text) => {
      live.delete(sessionID);
      live.set(sessionID, { turnKey, text });
      while (live.size > maxSessions) {
        const oldest = live.keys().next().value;
        if (oldest === undefined) break;
        live.delete(oldest);
      }
    },
    expire: (sessionID, turnKey) => {
      const current = live.get(sessionID);
      if (current && current.turnKey !== turnKey) live.delete(sessionID);
    },
    forget: (sessionID) => {
      live.delete(sessionID);
    },
    sessions: () => live.size,
  };
}
