import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { resolveInheritanceMode, stitchSystemPrompt } from "./inheritance.js";
import { providerPromptForModel } from "./provider-prompt.js";

export const AgentPromptInheritancePlugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || output.system.length === 0) return;

      const messages = await ctx.client.session.messages({
        path: { id: input.sessionID },
        query: { directory: ctx.directory, limit: 20 },
      });
      const agentName = messages.data
        ?.map((message) => (message.info as { agent?: string }).agent)
        .find(Boolean);
      if (!agentName) return;

      const agent = (
        await ctx.client.app.agents({ query: { directory: ctx.directory } })
      ).data?.find((entry) => entry.name === agentName);
      const mode = resolveInheritanceMode(agent?.options);
      if (!mode) return;

      output.system[0] = stitchSystemPrompt(
        providerPromptForModel(input.model),
        output.system[0],
        mode,
      );
    },
  };
};

export default {
  id: "capybearista.opencode-agent-prompt-inheritance",
  server: AgentPromptInheritancePlugin,
} satisfies PluginModule;
