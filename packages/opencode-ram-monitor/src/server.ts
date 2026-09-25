import { Plugin } from "@opencode/plugin";
import { debugLog } from "./debug.js";
import { getHeavyProcessTree } from "./memory.js";

const PROMPT_INJECTION_FAILURE_MESSAGE = "Unable to display RAM usage output. Please try again.";
const TREE_FAILURE_MESSAGE = "Unable to generate RAM usage tree. Please try again.";

export default Plugin.define({
  id: "capybearista.opencode-ram-monitor",
  async setup(ctx) {
    await ctx.command.transform((editor) => {
      editor.add({
        name: "ram",
        description: "Show a detailed process tree and RAM usage",
        async execute(invocation) {
          let treeText: string;
          try {
            treeText = await getHeavyProcessTree();
          } catch (error) {
            await debugLog("heavy-tree-failed", {
              sessionID: invocation.sessionID,
              error: error instanceof Error ? error.message : String(error),
            });
            treeText = TREE_FAILURE_MESSAGE;
          }

          try {
            await ctx.session.synthetic({
              sessionID: invocation.sessionID,
              text: treeText,
              description: "RAM usage tree",
              metadata: { source: "opencode-ram-monitor" },
              delivery: invocation.delivery,
              resume: false,
            });
          } catch (error) {
            await debugLog("prompt-inject-failed", {
              sessionID: invocation.sessionID,
              error: error instanceof Error ? error.message : String(error),
            });
            throw new Error(PROMPT_INJECTION_FAILURE_MESSAGE);
          }
        },
      });
    });
  },
});
