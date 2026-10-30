import { Rpc } from "@opencode/plugin/rpc";

export interface ReviewDetails {
  /** ISO time the consult finished. */
  readonly at: string;
  readonly model: string;
  readonly ms: number;
}

export interface ReviewSummary {
  readonly id: string;
  readonly moment: string;
  readonly advice: string;
  /** Kept in server memory only: null for a review delivered before an OpenCode restart. */
  readonly details: ReviewDetails | null;
}

export interface Status {
  readonly sessionID: string;
  readonly mode: "off" | "observe" | "active";
  /** `tui.sidebar` from the config. */
  readonly sidebar: boolean;
  readonly configError: string | null;
  readonly reviewing: boolean;
  /** Set on `review.finished` when the consult failed or timed out. */
  readonly failed: boolean;
  /** Latest automatic review, read from the session's instruction entry. */
  readonly latest: ReviewSummary | null;
}

const string = { type: "string" } as const;
const status = {
  type: "object",
  properties: {
    sessionID: string,
    mode: { enum: ["off", "observe", "active"] },
    sidebar: { type: "boolean" },
    configError: { type: ["string", "null"] },
    reviewing: { type: "boolean" },
    failed: { type: "boolean" },
    latest: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            id: string,
            moment: string,
            advice: string,
            details: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  properties: { at: string, model: string, ms: { type: "number" } },
                  required: ["at", "model", "ms"],
                },
              ],
            },
          },
          required: ["id", "moment", "advice", "details"],
        },
      ],
    },
  },
  required: ["sessionID", "mode", "sidebar", "configError", "reviewing", "failed", "latest"],
} as const;

export const AutoAdvisorRpc = Rpc.define({
  id: "auto-advisor",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID: string },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: status,
    },
  },
  events: {
    "review.started": { schema: status },
    "review.finished": { schema: status },
  },
});
