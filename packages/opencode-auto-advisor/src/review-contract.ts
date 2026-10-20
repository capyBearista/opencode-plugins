export const REVIEW_RPC_ID = "experimental.auto-advisor.review";

export const REVIEW_OUTCOMES = ["completed", "failed", "timeout"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export type ReviewEventName = "review.started" | "review.finished";

export type ReviewRun = {
  readonly id: string;
  readonly startedAt: number;
};

export type FinishedReviewRun = ReviewRun & {
  readonly finishedAt: number;
  readonly outcome: ReviewOutcome;
};

export type LatestReview = {
  readonly id: string;
  readonly finishedAt: number;
  readonly advice: string;
};

export type ReviewStatus = {
  readonly sessionID: string;
  readonly epoch: string;
  readonly revision: number;
  readonly running: readonly ReviewRun[];
  readonly lastFinished?: FinishedReviewRun;
  readonly latest?: LatestReview;
};

export const REVIEW_RUN_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    startedAt: { type: "number" },
  },
  required: ["id", "startedAt"],
  additionalProperties: false,
} as const;

export const REVIEW_FINISHED_RUN_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    startedAt: { type: "number" },
    finishedAt: { type: "number" },
    outcome: { type: "string", enum: REVIEW_OUTCOMES },
  },
  required: ["id", "startedAt", "finishedAt", "outcome"],
  additionalProperties: false,
} as const;

export const REVIEW_LATEST_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    finishedAt: { type: "number" },
    advice: { type: "string" },
  },
  required: ["id", "finishedAt", "advice"],
  additionalProperties: false,
} as const;

export const REVIEW_STATUS_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    epoch: { type: "string" },
    revision: { type: "number" },
    running: { type: "array", items: REVIEW_RUN_SCHEMA },
    lastFinished: REVIEW_FINISHED_RUN_SCHEMA,
    latest: REVIEW_LATEST_SCHEMA,
  },
  required: ["sessionID", "epoch", "revision", "running"],
  additionalProperties: false,
} as const;

export const REVIEW_STATUS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

export const REVIEW_RPC = {
  id: REVIEW_RPC_ID,
  methods: {
    status: {
      input: REVIEW_STATUS_INPUT_SCHEMA,
      output: REVIEW_STATUS_SCHEMA,
    },
  },
  events: {
    "review.started": { schema: REVIEW_STATUS_SCHEMA },
    "review.finished": { schema: REVIEW_STATUS_SCHEMA },
  },
} as const;
