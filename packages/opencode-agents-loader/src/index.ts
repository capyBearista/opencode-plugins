import os from "node:os";
import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import {
  type AgentBridgeContext,
  type AgentBridgeHandle,
  type AgentBridgeOptions,
  type AgentBridgeScopeResult,
  type AgentBridgeSyncResult,
  type CommandBridgeContext,
  type CommandBridgeHandle,
  type CommandBridgeLocation,
  type CommandBridgeOptions,
  type CommandBridgeScheduler,
  type CommandBridgeScopeResult,
  type CommandBridgeSyncResult,
  startAgentBridge,
  startCommandBridge,
  syncAgentLinks,
  syncCommandLinks,
} from "./command-bridge.js";

export type { AgentPatch, MarkdownEntry } from "./agent-source.js";
export {
  convertAgent,
  fallbackSanitization,
  parseMarkdown,
  parseMarkdownContent,
  validateAgentContent,
} from "./agent-source.js";

export type {
  AgentBridgeContext,
  AgentBridgeHandle,
  AgentBridgeOptions,
  AgentBridgeScopeResult,
  AgentBridgeSyncResult,
  CommandBridgeContext,
  CommandBridgeHandle,
  CommandBridgeLocation,
  CommandBridgeOptions,
  CommandBridgeScheduler,
  CommandBridgeScopeResult,
  CommandBridgeSyncResult,
};
export { startAgentBridge, startCommandBridge, syncAgentLinks, syncCommandLinks };

export interface RegistrationOptions extends CommandBridgeOptions {}

type LoaderContext = Pick<PluginContext, "location" | "agent" | "command">;

export async function registerPlugin(
  context: LoaderContext,
  options: RegistrationOptions = {},
): Promise<() => Promise<void>> {
  const home = options.home ?? os.homedir();
  let commandBridge: CommandBridgeHandle | undefined;
  let agentBridge: AgentBridgeHandle | undefined;
  try {
    commandBridge = await startCommandBridge(context, { ...options, home });
    agentBridge = await startAgentBridge(
      {
        location: context.location,
        agent: {
          // The host always provides reload; the fallback keeps direct unit fixtures inert.
          reload: context.agent.reload ?? (async () => {}),
        },
      },
      { ...options, home },
    );
  } catch (error) {
    await agentBridge?.dispose();
    await commandBridge?.dispose();
    throw error;
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    await agentBridge?.dispose();
    await commandBridge?.dispose();
  };
}

const AgentsLoaderPlugin = Plugin.define({
  id: "capybearista.opencode-agents-loader",
  setup: (context) => registerPlugin(context),
});

export default AgentsLoaderPlugin;
