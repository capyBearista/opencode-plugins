import type { Plugin } from "@opencode-ai/plugin";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { getHeavyProcessTree } from "./memory.js";

export const RamMonitorPlugin: Plugin = async (ctx) => {
  return {
    config: async (opencodeConfig) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command.ram = {
        template: "",
        description: "Show a detailed process tree and RAM usage",
      };
    },
    "command.execute.before": async (input) => {
      if (input.command !== "ram") return;

      let treeText: string;
      try {
        treeText = await getHeavyProcessTree();
      } catch {
        treeText = "Unable to generate RAM usage tree. Please try again.";
      }

      try {
        await ctx.client.session.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text: treeText,
                ignored: true,
              },
            ],
          },
        });
      } catch {
        // swallow prompt errors
      }

      throw new Error("__STYLE_COMMAND_HANDLED__");
    },
  };
};

export const tui: TuiPlugin = async (api) => {
  const { RamWidget } = await import("./tui.js");
  api.slots.register({
    slots: {
      home_footer: RamWidget,
      sidebar_footer: RamWidget,
    },
  });
};

export default {
  id: "capybearista.opencode-ram-monitor",
  server: RamMonitorPlugin,
  tui,
};
