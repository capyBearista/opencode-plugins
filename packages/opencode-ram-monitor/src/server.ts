import type { Plugin } from "@opencode-ai/plugin";
import { debugLog } from "./debug.js";
import { getHeavyProcessTree } from "./memory.js";

const COMMAND_HANDLED_SENTINEL = "__RAM_COMMAND_HANDLED__";
const PROMPT_INJECTION_FAILURE_MESSAGE = "Unable to display RAM usage output. Please try again.";

function handled(): never {
  throw new Error(COMMAND_HANDLED_SENTINEL);
}

const RamMonitorServer: Plugin = async ({ client }) => {
  async function injectRawOutput(sessionID: string, output: string): Promise<boolean> {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: output, ignored: true }],
        },
      });
      return true;
    } catch (error) {
      await debugLog("prompt-inject-failed", {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return {
    config: async (cfg) => {
      cfg.command ??= {};
      cfg.command.ram = {
        template: "",
        description: "Show a detailed process tree and RAM usage",
      };
    },
    "command.execute.before": async (input, _output) => {
      if (input.command !== "ram") return;

      let treeText: string;
      try {
        treeText = await getHeavyProcessTree();
      } catch (error) {
        await debugLog("heavy-tree-failed", {
          sessionID: input.sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
        treeText = "Unable to generate RAM usage tree. Please try again.";
      }

      const injected = await injectRawOutput(input.sessionID, treeText);
      if (!injected) {
        throw new Error(PROMPT_INJECTION_FAILURE_MESSAGE);
      }
      handled();
    },
  };
};

export default {
  id: "capybearista.opencode-ram-monitor",
  server: RamMonitorServer,
};
