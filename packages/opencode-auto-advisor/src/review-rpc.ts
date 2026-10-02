import { Rpc } from "@opencode/plugin";
import type { RpcDomain } from "@opencode/plugin/promise/rpc";
import { REVIEW_RPC } from "./review-contract.js";
import type { ReviewLifecycle } from "./review-lifecycle.js";

export const ReviewRpc = Rpc.define(REVIEW_RPC);

export interface ReviewRpcRegistrationHandle {
  readonly dispose: () => Promise<void>;
}

export async function registerReviewRpc(
  rpc: RpcDomain,
  lifecycle: ReviewLifecycle,
): Promise<ReviewRpcRegistrationHandle> {
  const registration = await rpc.register(ReviewRpc, {
    status: async (input) => lifecycle.status(readSessionID(input)),
  });

  lifecycle.setEmitter((event, snapshot) =>
    event === "review.started"
      ? registration.events.emit("review.started", snapshot)
      : registration.events.emit("review.finished", snapshot),
  );

  let disposed = false;
  return {
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      lifecycle.setEmitter(undefined);
      await registration.dispose();
    },
  };
}

function readSessionID(input: unknown): string {
  if (isRecord(input) && typeof input.sessionID === "string") return input.sessionID;
  throw new Error("review status requires a string sessionID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
