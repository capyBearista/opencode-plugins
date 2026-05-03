import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import matter from "gray-matter";

function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;

  const frontmatter = match[1];
  const lines = frontmatter.split(/\r?\n/);
  const result: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("#") || line.trim() === "") {
      result.push(line);
      continue;
    }
    if (line.match(/^\s+/)) {
      result.push(line);
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      result.push(line);
      continue;
    }
    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    if (
      value === "" ||
      value === ">" ||
      value === "|" ||
      value.startsWith('"') ||
      value.startsWith("'")
    ) {
      result.push(line);
      continue;
    }
    if (value.includes(":")) {
      result.push(`${key}: |-`);
      result.push(`  ${value}`);
      continue;
    }
    result.push(line);
  }

  const processed = result.join("\n");
  return content.replace(match[0], () => `---\n${processed}\n---`);
}

async function parseMarkdown(filePath: string) {
  const template = await Bun.file(filePath).text();

  try {
    return matter(template);
  } catch {
    try {
      return matter(fallbackSanitization(template));
    } catch (err) {
      throw new Error(
        `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function scanDirectory(dir: string, subdirs: string[]) {
  const result: Record<string, { data: Record<string, unknown>; content: string }> = {};

  for (const subdir of subdirs) {
    const targetDir = path.join(dir, subdir);
    try {
      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const glob = new Bun.Glob("**/*.md");
    for await (const file of glob.scan({ cwd: targetDir })) {
      try {
        const fullPath = path.join(targetDir, file);
        const md = await parseMarkdown(fullPath);
        const ext = path.extname(file);
        const name = ext.length ? file.slice(0, -ext.length) : file;
        // Normalize slashes for name
        const normalizedName = name.replaceAll("\\", "/");
        result[normalizedName] = {
          data: md.data as Record<string, unknown>,
          content: md.content.trim(),
        };
      } catch (err) {
        console.error(`[capybearista.opencode-agents-loader] Failed to parse ${file}:`, err);
      }
    }
  }

  return result;
}

async function findProjectDirs(
  startDir: string,
  folderName: string,
  worktree?: string,
): Promise<string[]> {
  const dirs: string[] = [];
  let current = startDir;

  while (true) {
    const targetDir = path.join(current, folderName);
    try {
      const stat = await fs.stat(targetDir);
      if (stat.isDirectory()) dirs.push(targetDir);
    } catch {
      // directory doesn't exist
    }
    if (worktree && current === worktree) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Reverse so deepest directories are processed last and retain highest precedence
  return dirs.reverse();
}

export const AgentsLoaderPlugin: Plugin = async ({ directory, worktree }) => {
  return {
    config: async (cfg) => {
      const globalAgentsDir = path.join(os.homedir(), ".agents");

      const localOpencodeDirs = await findProjectDirs(directory, ".opencode", worktree);
      const localOpencodeCommands = new Set<string>();
      const localOpencodeAgents = new Set<string>();

      for (const dir of localOpencodeDirs) {
        const cmds = await scanDirectory(dir, ["command", "commands"]);
        for (const name of Object.keys(cmds)) localOpencodeCommands.add(name);

        const agts = await scanDirectory(dir, ["agent", "agents"]);
        for (const name of Object.keys(agts)) localOpencodeAgents.add(name);
      }

      // --- Commands ---
      const projectCommands: Record<string, unknown> = {};
      const projectAgentsDirs = await findProjectDirs(directory, ".agents", worktree);

      for (const dir of projectAgentsDirs) {
        const cmds = await scanDirectory(dir, ["command", "commands"]);
        for (const [name, entry] of Object.entries(cmds)) {
          projectCommands[name] = { ...entry.data, template: entry.content };
        }
      }

      const globalCommands: Record<string, unknown> = {};
      const globalCmds = await scanDirectory(globalAgentsDir, ["command", "commands"]);
      for (const [name, entry] of Object.entries(globalCmds)) {
        globalCommands[name] = { ...entry.data, template: entry.content };
      }

      if (!cfg.command) cfg.command = {};

      for (const [name, command] of Object.entries(globalCommands)) {
        if (!(name in cfg.command) && !(name in projectCommands)) {
          // @ts-expect-error Safe bypass of strict config types
          cfg.command[name] = command;
        }
      }

      for (const [name, command] of Object.entries(projectCommands)) {
        if (!localOpencodeCommands.has(name)) {
          // @ts-expect-error Safe bypass of strict config types
          cfg.command[name] = command;
        }
      }

      // --- Agents ---
      const projectAgents: Record<string, unknown> = {};
      for (const dir of projectAgentsDirs) {
        const agts = await scanDirectory(dir, ["agent", "agents"]);
        for (const [name, entry] of Object.entries(agts)) {
          projectAgents[name] = { ...entry.data, prompt: entry.content };
        }
      }

      const globalAgents: Record<string, unknown> = {};
      const globalAgts = await scanDirectory(globalAgentsDir, ["agent", "agents"]);
      for (const [name, entry] of Object.entries(globalAgts)) {
        globalAgents[name] = { ...entry.data, prompt: entry.content };
      }

      if (!cfg.agent) cfg.agent = {};

      for (const [name, agent] of Object.entries(globalAgents)) {
        if (!(name in cfg.agent) && !(name in projectAgents)) {
          // @ts-expect-error Safe bypass of strict config types
          cfg.agent[name] = agent;
        }
      }

      for (const [name, agent] of Object.entries(projectAgents)) {
        if (!localOpencodeAgents.has(name)) {
          // @ts-expect-error Safe bypass of strict config types
          cfg.agent[name] = agent;
        }
      }
    },
  };
};

export default {
  id: "capybearista.opencode-agents-loader",
  server: AgentsLoaderPlugin,
};
