import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { resolveInheritanceMode, stitchSystemPrompt } from "./inheritance.js";
import { captureTransformedSystemPrompt } from "./prompt-capture.js";
import { providerPromptForModel } from "./provider-prompt.js";

export const AgentPromptInheritancePlugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (output.system.length === 0) return;
      if (!input.sessionID) {
        console.warn("[AgentPromptInheritance] Missing sessionID in transform hook");
        return;
      }

      let agentName: string | undefined;
      let agent: { options?: Record<string, unknown> } | undefined;

      try {
        const messages = await ctx.client.session.messages({
          path: { id: input.sessionID },
          query: { directory: ctx.directory, limit: 20 },
        });
        const messageData = messages.data;
        const normalizedMessages = Array.isArray(messageData)
          ? (messageData as { info?: { agent?: string } }[])
          : [];
        agentName = normalizedMessages.findLast((m) => m.info?.agent)?.info?.agent;
        if (!agentName) return;

        const agentsRes = await ctx.client.app.agents({ query: { directory: ctx.directory } });
        const agents = agentsRes.data;
        agent = Array.isArray(agents)
          ? (agents as { name: string; options?: Record<string, unknown> }[]).find(
              (entry) => entry.name === agentName,
            )
          : undefined;

        if (!agent) {
          console.warn(
            `[AgentPromptInheritance] Agent "${agentName}" found in history but not in available agents list`,
          );
        }
      } catch (error) {
        console.warn("[AgentPromptInheritance] Failed to resolve active agent or messages:", error);
        return;
      }
      const mode = resolveInheritanceMode(agent?.options);
      if (!mode) {
        void captureTransformedSystemPrompt({
          agentName,
          mode: null,
          modelID: input.model.api.id,
          inherited: false,
          sessionID: input.sessionID,
          system: output.system,
        });
        return;
      }

      const base = providerPromptForModel(input.model);
      const custom = output.system[0];

      if (typeof custom === "string") {
        output.system[0] = stitchSystemPrompt(base, custom, mode);
      } else {
        console.warn(
          "[AgentPromptInheritance] System prompt [0] is not a string, skipping transformation",
        );
      }

      void captureTransformedSystemPrompt({
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
