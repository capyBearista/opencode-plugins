import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import * as yaml from "yaml";

interface OutputStyle {
  id: string;
  name: string;
  description: string;
  body: string;
}

async function parseStyleFile(filePath: string): Promise<OutputStyle | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = yaml.parse(match[1]);
    const body = match[2].trim();
    const id = path.parse(filePath).name;

    return {
      id,
      name: frontmatter.name || id,
      description: frontmatter.description || "",
      body,
    };
  } catch {
    return null;
  }
}

async function discoverStyles(projectPath: string): Promise<OutputStyle[]> {
  const globalPath = path.join(os.homedir(), ".config", "opencode", "output-styles");
  const localPath = path.join(projectPath, ".opencode", "output-styles");

  const styles = new Map<string, OutputStyle>();

  for (const dir of [globalPath, localPath]) {
    try {
      const files = await fs.readdir(dir, { recursive: true });
      for (const file of files) {
        if (typeof file === "string" && file.endsWith(".md")) {
          const style = await parseStyleFile(path.join(dir, file));
          if (style) {
            styles.set(style.id, style);
          }
        }
      }
    } catch {
      // Directory might not exist, ignore
    }
  }

  return Array.from(styles.values());
}

export const server: Plugin = async (ctx) => {
  const projectPath = ctx.worktree || ctx.directory;
  const configPath = path.join(projectPath, ".opencode", "active-style.json");

  // In-memory cache for fast system prompt transformation
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
    cachedActiveStyle = undefined; // invalidate active style object
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ activeStyle: id }, null, 2));
    } catch {
      // Silently ignore write failures (e.g., read-only filesystem)
    }
  };

  const getActiveStyle = async (id: string): Promise<OutputStyle | null> => {
    if (cachedActiveStyle !== undefined) return cachedActiveStyle || null;

    // Load from specific path to avoid O(N) disk I/O
    const globalPath = path.join(os.homedir(), ".config", "opencode", "output-styles", `${id}.md`);
    const localPath = path.join(projectPath, ".opencode", "output-styles", `${id}.md`);

    for (const p of [localPath, globalPath]) {
      // Local takes precedence
      const style = await parseStyleFile(p);
      if (style) {
        cachedActiveStyle = style;
        return style;
      }
    }

    // Fallback: discover full map in case it's in a nested folder
    const styles = await discoverStyles(projectPath);
    const found = styles.find((s) => s.id === id) || null;
    cachedActiveStyle = found;
    return found;
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
            resultMsg += `- **${style.id}**: ${style.name} - ${style.description}${activeMark}\n`;
          }
          resultMsg +=
            "\nUse `/style <id>` to select a style, or `/style clear` to remove the active style.";
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
        output.system.push(`\n# Output Style: ${activeStyle.name}\n${activeStyle.body}`);
      }
    },
  };
};

const pluginModule: PluginModule = {
  id: "capybearista.opencode-output-styles",
  server,
};

export default pluginModule;
