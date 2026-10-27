import { constants } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_STYLE_ID } from "./rpc.js";

export type StyleSource = "built-in" | "global" | "project";

export interface Style {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly turnReminder?: string;
  readonly source: StyleSource;
}

export { DEFAULT_STYLE_ID };

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

function parseStyle(file: string, raw: string, source: StyleSource): Style | undefined {
  const id = basename(file).slice(0, -".md".length).toLowerCase();
  if (id === DEFAULT_STYLE_ID) return undefined;

  // Editors on Windows often save a UTF-8 BOM, which would hide the frontmatter.
  const content = raw.replace(/^\uFEFF/, "");
  const match = FRONTMATTER.exec(content);
  let data: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed: unknown = parse(match[1] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {}
  }

  const prompt = (match ? (match[2] ?? "") : content).trim();
  if (!prompt) return undefined;

  const text = (value: unknown) => (value == null ? "" : String(value));
  const reminder = data["turn-reminder"];
  return {
    id,
    name: text(data.name) || basename(file).slice(0, -".md".length),
    description: text(data.description),
    prompt,
    ...(typeof reminder === "string" && reminder ? { turnReminder: reminder } : {}),
    source,
  };
}

async function loadDir(dir: string, source: StyleSource): Promise<Style[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const styles = await Promise.all(
    entries
      .filter((entry) => entry.toLowerCase().endsWith(".md"))
      .map(async (entry) => {
        const file = join(dir, entry);
        let handle: FileHandle | undefined;
        try {
          // Check and read through one handle; O_NONBLOCK keeps a FIFO from blocking the open.
          handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
          if (!(await handle.stat()).isFile()) return undefined;
          return parseStyle(file, await handle.readFile("utf8"), source);
        } catch {
          return undefined;
        } finally {
          await handle?.close();
        }
      }),
  );
  return styles.filter((style) => style !== undefined);
}

export async function discoverStyles(options: {
  readonly project: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly builtinDir?: string;
}): Promise<Map<string, Style>> {
  const builtinDir =
    options.builtinDir ?? fileURLToPath(new URL("../built-in-styles", import.meta.url));
  const sources: Array<[string, StyleSource]> = [
    [builtinDir, "built-in"],
    [join(configDir(options.env), "output-styles"), "global"],
    [join(options.project, ".opencode", "output-styles"), "project"],
  ];

  // Read in parallel, then apply in source order so later sources still win.
  const loaded = await Promise.all(sources.map(([dir, source]) => loadDir(dir, source)));
  const styles = new Map<string, Style>();
  for (const style of loaded.flat()) styles.set(style.id, style);
  return styles;
}

export function findStyle(styles: ReadonlyMap<string, Style>, query: string): Style | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const byId = styles.get(needle);
  if (byId) return byId;
  return [...styles.values()].find((style) => style.name.trim().toLowerCase() === needle);
}
