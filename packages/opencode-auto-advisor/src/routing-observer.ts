import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { AdvisorService } from "./advisor-service.js";
import type { AdvisorConfig } from "./config.js";
import { type CapturedRequest, captureAssembledRequest } from "./request.js";
import { createRoutingDomain } from "./routing.js";
import type { AdvisorRouter } from "./routing-types.js";
import type { SnapshotStore } from "./snapshot-store.js";

type ObserverContext = Pick<PluginContext, "session">;

export interface RoutingObserverDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly router: AdvisorRouter;
  readonly service: AdvisorService;
  readonly snapshots: SnapshotStore;
}

export async function registerRoutingObserver(context: ObserverContext, deps: RoutingObserverDeps) {
  const domain = createRoutingDomain(deps);
  return context.session.hook("context", async (dispatch) => {
    const kind = readDispatchKind(dispatch);
    if (kind !== undefined && kind !== "primary") return;
    let captured: CapturedRequest;
    try {
      captured = captureAssembledRequest(dispatch);
    } catch {
      return;
    }
    deps.snapshots.capture({
      sessionID: captured.sessionID,
      turnKey: captured.turnKey,
      entries: captured.entries,
      executorModel: captured.executorModel,
    });
    await domain.observe({
      sessionID: captured.sessionID,
      ...(kind === "primary" ? { kind } : {}),
      capture: async () => ({
        entries: captured.entries,
        lastUserMessageID: captured.turnKey,
        executorModel: captured.executorModel,
      }),
    });
  });
}

function readDispatchKind(dispatch: object): unknown {
  return (dispatch as { readonly kind?: unknown }).kind;
}
