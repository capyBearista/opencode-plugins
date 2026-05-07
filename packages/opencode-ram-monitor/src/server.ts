import type { Plugin } from "@opencode-ai/plugin";
import { getHeavyProcessTree } from "./memory.js";

const COMMAND_HANDLED_SENTINEL = "__RAM_COMMAND_HANDLED__";

function handled(): never {
  throw new Error(COMMAND_HANDLED_SENTINEL);
}

const RamMonitorServer: Plugin = async ({ client }) => {
  async function injectRawOutput(sessionID: string, output: string): Promise<void> {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: output, ignored: true }],
        },
      });
    } catch {
      // swallow prompt errors
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
      } catch {
        treeText = "Unable to generate RAM usage tree. Please try again.";
      }

      await injectRawOutput(input.sessionID, treeText);
      handled();
    },
  };
};

export default {
  id: "capybearista.opencode-ram-monitor",
  server: RamMonitorServer,
};
