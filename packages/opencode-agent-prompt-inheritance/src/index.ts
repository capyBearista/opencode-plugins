import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { resolveInheritanceMode, stitchSystemPrompt } from "./inheritance.js";
import { captureTransformedSystemPrompt } from "./prompt-capture.js";
import { providerPromptForModel } from "./provider-prompt.js";

export const AgentPromptInheritancePlugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || output.system.length === 0) return;

      let agentName: string | undefined;
      let agent: { options?: any } | undefined;

      try {
        const messages = await ctx.client.session.messages({
          path: { id: input.sessionID },
          query: { directory: ctx.directory, limit: 20 },
        });
        agentName = [...(messages.data || [])]
          .reverse()
          .map((message) => (message.info as { agent?: string })?.agent)
          .find(Boolean);
        if (!agentName) return;

        const agentsRes = await ctx.client.app.agents({ query: { directory: ctx.directory } });
        agent = agentsRes.data?.find((entry) => entry.name === agentName);
      } catch {
        return;
      }
      const mode = resolveInheritanceMode(agent?.options);
      if (!mode) {
        await captureTransformedSystemPrompt({
          agentName,
          mode: null,
          modelID: input.model.api.id,
          inherited: false,
          sessionID: input.sessionID,
          system: output.system,
        });
        return;
      }

      output.system[0] = stitchSystemPrompt(
        providerPromptForModel(input.model),
        output.system[0],
        mode,
      );
      await captureTransformedSystemPrompt({
        agentName,
        mode,
        modelID: input.model.api.id,
        inherited: true,
        sessionID: input.sessionID,
        system: output.system,
      });
    },
  };
};

export default {
  id: "capybearista.opencode-agent-prompt-inheritance",
  server: AgentPromptInheritancePlugin,
} satisfies PluginModule;
