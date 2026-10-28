import { Rpc } from "@opencode/plugin/rpc";

export interface ReviewSummary {
  readonly id: string;
  readonly moment: string;
  readonly advice: string;
}

export interface Status {
  readonly sessionID: string;
  readonly mode: "off" | "observe" | "active";
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
    configError: { type: ["string", "null"] },
    reviewing: { type: "boolean" },
    failed: { type: "boolean" },
    latest: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: { id: string, moment: string, advice: string },
          required: ["id", "moment", "advice"],
        },
      ],
    },
  },
  required: ["sessionID", "mode", "configError", "reviewing", "failed", "latest"],
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
