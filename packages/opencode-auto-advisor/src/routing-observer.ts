import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { AdvisorService } from "./advisor-service.js";
import type { AdvisorConfig } from "./config.js";
import { captureAdvisorContext } from "./context.js";
import { createRoutingDomain } from "./routing.js";
import type { AdvisorRouter } from "./routing-types.js";

type ObserverContext = Pick<PluginContext, "session">;

export interface RoutingObserverDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly router: AdvisorRouter;
  readonly service: AdvisorService;
}

const NO_IN_FLIGHT_MESSAGE = "";

export async function registerRoutingObserver(context: ObserverContext, deps: RoutingObserverDeps) {
  const domain = createRoutingDomain(deps);
  return context.session.hook("context", async (dispatch) => {
    const kind = readDispatchKind(dispatch);
    if (kind !== undefined && kind !== "primary") return;
    await domain.observe({
      sessionID: dispatch.sessionID,
      ...(kind === "primary" ? { kind } : {}),
      capture: async () => {
        const captured = await captureAdvisorContext(context.session, {
          sessionID: dispatch.sessionID,
          messageID: NO_IN_FLIGHT_MESSAGE,
        });
        return {
          entries: captured.entries,
          lastUserMessageID: captured.lastUserMessageID ?? "",
          ...(captured.executorModel ? { executorModel: captured.executorModel } : {}),
        };
      },
    });
  });
}

function readDispatchKind(dispatch: object): unknown {
  return (dispatch as { readonly kind?: unknown }).kind;
}
