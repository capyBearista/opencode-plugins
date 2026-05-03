import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { discoverStyles, findStyleById, isBuiltinStyle, type OutputStyle } from "./styles.js";

export const server: Plugin = async (ctx) => {
  const projectPath = ctx.worktree || ctx.directory;
  const configPath = path.join(projectPath, ".opencode", "active-style.json");

  let cachedActiveId: string | null | undefined;
  let cachedActiveStyle: OutputStyle | null | undefined;

  const getActiveStyleId = async (): Promise<string | null> => {
    if (cachedActiveId !== undefined) return cachedActiveId;
    try {
      const data = await fs.readFile(configPath, "utf-8");
      cachedActiveId = JSON.parse(data).activeStyle;
      return cachedActiveId || null;
    } catch {
      cachedActiveId = null;
      return null;
    }
  };

  const setActiveStyleId = async (id: string | null) => {
    cachedActiveId = id;
    cachedActiveStyle = undefined;
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ activeStyle: id }, null, 2));
    } catch {
      // Silently ignore write failures
    }
  };

  const getActiveStyle = async (id: string): Promise<OutputStyle | null> => {
    if (cachedActiveStyle !== undefined) return cachedActiveStyle || null;
    cachedActiveStyle = await findStyleById(projectPath, id);
    return cachedActiveStyle;
  };

  return {
    config: async (opencodeConfig) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command["output-style"] = {
        template: "",
        description: "List, set, or clear the active output style",
      };
    },

    "command.execute.before": async (input) => {
      if (input.command !== "output-style") return;

      const styles = await discoverStyles(projectPath);
      const args = input.arguments.trim().split(/\s+/);
      const firstArg = args[0];

      let resultMsg = "";

      if (!firstArg) {
        const activeId = await getActiveStyleId();

        if (styles.length === 0) {
          resultMsg =
            "No output styles found. Create .md files with YAML frontmatter in `~/.config/opencode/output-styles/` or `.opencode/output-styles/`.";
        } else {
          resultMsg = "Available Output Styles:\n\n";
          for (const style of styles) {
            const activeMark = style.id === activeId ? " (Active)" : "";
            const builtinMark = (await isBuiltinStyle(style.id)) ? " [Built-in]" : "";
            resultMsg += `- **${style.id}**: ${style.name} - ${style.description}${builtinMark}${activeMark}\n`;
          }
          resultMsg +=
            "\nUse `/output-style <id>` to select a style, or `/output-style clear` to remove the active style.";
        }
      } else {
        const selectedId = firstArg;

        if (selectedId === "clear") {
          await setActiveStyleId(null);
          resultMsg = "Cleared active output style.";
        } else {
          const style = styles.find((s) => s.id === selectedId);
          if (!style) {
            resultMsg = `Style not found: ${selectedId}`;
          } else {
            await setActiveStyleId(style.id);
            resultMsg = `Active output style set to: ${style.name}`;
          }
        }
      }

      await ctx.client.session.prompt({
        path: { id: input.sessionID },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              text: resultMsg,
              ignored: true,
            },
          ],
        },
      });

      throw new Error("__STYLE_COMMAND_HANDLED__");
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const activeId = await getActiveStyleId();
      if (!activeId) return;

      const activeStyle = await getActiveStyle(activeId);
      if (!activeStyle) return;

      if (output.system) {
        output.system.push(`\n<output-style>\n${activeStyle.body}\n</output-style>`);
      }
    },
  };
};

const pluginModule: PluginModule = {
  id: "capybearista.opencode-output-styles",
  server,
};

export default pluginModule;
