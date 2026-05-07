import type { Plugin } from "@opencode-ai/plugin";

export const AdversarialReviewPlugin: Plugin = async () => {
  return {
    config: async (cfg) => {
      if (!cfg.agent) cfg.agent = {};
      if (!cfg.agent["adversarial-review"]) {
        cfg.agent["adversarial-review"] = {
          description:
            "Adversarial code review — challenges implementation approach and design choices",
          mode: "subagent",
          model: "openai/gpt-5.4",
          temperature: 0.1,
          color: "warning",
          permission: {
            edit: "deny",
            bash: {
              "git *": "allow",
              "*": "deny",
            },
            read: "allow",
            glob: "allow",
            grep: "allow",
          },
          prompt: "",
        };
      }

      if (!cfg.command) cfg.command = {};
      if (!cfg.command["adversarial-review"]) {
        cfg.command["adversarial-review"] = {
          description: "Run an adversarial code review that challenges the implementation",
          argumentHint: "[--base <ref>] [--scope auto|working-tree|branch] [focus ...]",
          agent: "adversarial-review",
          subtask: true,
          template: "",
        };
      }
    },
  };
};

export default {
  id: "capybearista.opencode-adversarial-review",
  server: AdversarialReviewPlugin,
};
