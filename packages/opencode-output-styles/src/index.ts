import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import * as yaml from "yaml";

interface OutputStyle {
  id: string;
  name: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
}

async function parseStyleFile(filePath: string): Promise<OutputStyle | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = yaml.parse(match[1]);
    const body = match[2].trim();
    const id = path.parse(filePath).name;

    return {
      id,
      name: frontmatter.name || id,
      description: frontmatter.description || "",
      keepCodingInstructions: frontmatter["keep-coding-instructions"] !== false, // defaults to true
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
    } catch (e) {
      console.error("Failed to save active style", e);
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
    "command.execute.before": async (input, output) => {
      if (input.command === "style") {
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

        // Note: The OpenCode Plugin API doesn't currently provide a direct way to abort
        // a command execution without generating an LLM response or throwing an error stack trace.
        // As a workaround, we overwrite the parts to explicitly instruct the LLM to echo our response.
        // This is fragile but necessary until a proper short-circuit API exists.
        output.parts = [
          {
            type: "text",
            id: Date.now().toString(),
            sessionID: input.sessionID,
            messageID: "system",
            text: `I have handled the user's /style command. Acknowledge this to the user by printing exactly this response and nothing else:\n\n${resultMsg}`,
          },
        ];
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const activeId = await getActiveStyleId();
      if (!activeId) return;

      const activeStyle = await getActiveStyle(activeId);
      if (!activeStyle) return;

      if (output.system && output.system.length > 0) {
        if (!activeStyle.keepCodingInstructions) {
          // Anthropic prompt uses # Doing tasks up to # Tool usage policy
          output.system[0] = output.system[0].replace(
            /# Doing tasks[\s\S]*?(?=# Tool usage policy)/,
            "",
          );
          // Gemini / GPT prompt uses # Core Mandates up to # Operational Guidelines
          output.system[0] = output.system[0].replace(
            /# Core Mandates[\s\S]*?(?=# Operational Guidelines)/,
            "",
          );
        }

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
