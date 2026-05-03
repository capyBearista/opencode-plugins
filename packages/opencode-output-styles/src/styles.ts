import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";

export interface OutputStyle {
  id: string;
  name: string;
  description: string;
  body: string;
}

function getBuiltinStylesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "built-in-styles");
}

export async function parseStyleFile(filePath: string): Promise<OutputStyle | null> {
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

export async function loadBuiltinStyles(): Promise<OutputStyle[]> {
  const dir = getBuiltinStylesDir();
  try {
    const files = await fs.readdir(dir);
    const styles: OutputStyle[] = [];
    for (const file of files) {
      if (file.endsWith(".md")) {
        const style = await parseStyleFile(path.join(dir, file));
        if (style) styles.push(style);
      }
    }
    return styles;
  } catch {
    return [];
  }
}

export async function isBuiltinStyle(id: string): Promise<boolean> {
  const builtins = await loadBuiltinStyles();
  return builtins.some((s) => s.id === id);
}

export async function discoverStyles(projectPath: string): Promise<OutputStyle[]> {
  const globalPath = path.join(os.homedir(), ".config", "opencode", "output-styles");
  const localPath = path.join(projectPath, ".opencode", "output-styles");
  const styles = new Map<string, OutputStyle>();

  for (const style of await loadBuiltinStyles()) {
    styles.set(style.id, style);
  }

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

export async function findStyleById(projectPath: string, id: string): Promise<OutputStyle | null> {
  const localPath = path.join(projectPath, ".opencode", "output-styles", `${id}.md`);
  const localStyle = await parseStyleFile(localPath);
  if (localStyle) return localStyle;

  const globalPath = path.join(os.homedir(), ".config", "opencode", "output-styles", `${id}.md`);
  const globalStyle = await parseStyleFile(globalPath);
  if (globalStyle) return globalStyle;

  const builtins = await loadBuiltinStyles();
  return builtins.find((s) => s.id === id) || null;
}
