import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, discoverStyles, findStyle } from "./styles.js";

let root: string;
let project: string;
let config: string;
let env: NodeJS.ProcessEnv;

const globalDir = () => join(config, "output-styles");
const projectDir = () => join(project, ".opencode", "output-styles");

async function put(dir: string, file: string, content: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "output-styles-"));
  project = join(root, "project");
  config = join(root, "config");
  env = { OPENCODE_CONFIG_DIR: config };
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("built-in styles", () => {
  test("loads the four bundled styles", async () => {
    const styles = await discoverStyles({ project, env });
    expect([...styles.keys()].sort()).toEqual(["concise", "explanatory", "learning", "proactive"]);
    expect(styles.get("proactive")?.name).toBe("Proactive");
    expect(styles.get("concise")?.name).toBe("Concise");
    expect(styles.get("explanatory")?.name).toBe("Explanatory");
    expect(styles.get("learning")?.name).toBe("Learning");
    expect(styles.get("concise")?.turnReminder).toBeTruthy();
    expect(styles.get("explanatory")?.turnReminder).toBeUndefined();
    for (const style of styles.values()) {
      expect(style.keepCodingInstructions).toBe(true);
      expect(style.source).toBe("built-in");
      expect(style.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("override order", () => {
  test("global overrides built-in, project overrides global", async () => {
    await put(globalDir(), "concise.md", "---\nname: G\n---\nglobal body");
    let styles = await discoverStyles({ project, env });
    expect(styles.get("concise")).toMatchObject({ name: "G", source: "global" });

    await put(projectDir(), "concise.md", "---\nname: P\n---\nproject body");
    styles = await discoverStyles({ project, env });
    expect(styles.get("concise")).toMatchObject({
      name: "P",
      prompt: "project body",
      source: "project",
    });
  });

  test("override replaces the whole style without merging fields", async () => {
    await put(globalDir(), "concise.md", "---\nname: Mine\n---\nbody");
    const concise = (await discoverStyles({ project, env })).get("concise");
    expect(concise?.turnReminder).toBeUndefined();
    expect(concise?.description).toBe("");
  });

  test("re-reads from disk on every call", async () => {
    await discoverStyles({ project, env });
    await put(globalDir(), "fresh.md", "body");
    expect((await discoverStyles({ project, env })).has("fresh")).toBe(true);
  });
});

describe("configDir", () => {
  test("OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME", () => {
    expect(configDir({ OPENCODE_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" })).toBe("/a");
  });

  test("XDG_CONFIG_HOME/opencode when no override", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/b" })).toBe(join("/b", "opencode"));
  });

  test("falls back to ~/.config/opencode", () => {
    expect(configDir({})).toBe(join(homedir(), ".config", "opencode"));
    expect(configDir({ OPENCODE_CONFIG_DIR: "" })).toBe(join(homedir(), ".config", "opencode"));
  });
});

describe("filesystem handling", () => {
  test("reads frontmatter from a file saved with a UTF-8 BOM", async () => {
    await put(
      globalDir(),
      "bom.md",
      "\uFEFF---\nname: With BOM\nkeep-coding-instructions: false\n---\nbody",
    );
    const style = (await discoverStyles({ project, env })).get("bom");
    expect(style).toMatchObject({
      name: "With BOM",
      prompt: "body",
      keepCodingInstructions: false,
    });
  });

  test("follows a symlinked source directory and symlinked files", async () => {
    const real = join(root, "real");
    await put(real, "linked-dir.md", "from linked dir");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await symlink(real, projectDir());

    const other = join(root, "elsewhere");
    await put(other, "target.md", "from linked file");
    await symlink(join(other, "target.md"), join(real, "linked-file.md"));

    const styles = await discoverStyles({ project, env });
    expect(styles.get("linked-dir")?.prompt).toBe("from linked dir");
    expect(styles.get("linked-file")?.prompt).toBe("from linked file");
  });

  test("skips broken symlinks", async () => {
    await mkdir(globalDir(), { recursive: true });
    await symlink(join(root, "missing.md"), join(globalDir(), "broken.md"));
    const styles = await discoverStyles({ project, env });
    expect(styles.has("broken")).toBe(false);
    expect(styles.size).toBe(4);
  });

  test("is flat: nested directories are ignored", async () => {
    await put(join(globalDir(), "dir"), "sub.md", "nested");
    await mkdir(join(globalDir(), "folder.md"));
    const styles = await discoverStyles({ project, env });
    expect(styles.has("sub")).toBe(false);
    expect(styles.has("folder")).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "skips a FIFO named *.md without blocking",
    async () => {
      await mkdir(globalDir(), { recursive: true });
      expect(Bun.spawnSync(["mkfifo", join(globalDir(), "pipe.md")]).exitCode).toBe(0);
      const styles = await discoverStyles({ project, env });
      expect(styles.has("pipe")).toBe(false);
      expect(styles.size).toBe(4);
    },
  );

  test("only .md files, case-insensitive; id is lowercased", async () => {
    await put(globalDir(), "Mixed.MD", "body");
    await put(globalDir(), "notes.txt", "body");
    const styles = await discoverStyles({ project, env });
    expect(styles.get("mixed")?.name).toBe("Mixed");
    expect(styles.has("notes")).toBe(false);
  });
});

describe("parsing", () => {
  test("bad YAML still loads with filename name and body", async () => {
    await put(globalDir(), "broken.md", "---\nname: [unclosed\n---\n\nthe body\n");
    expect((await discoverStyles({ project, env })).get("broken")).toMatchObject({
      name: "broken",
      description: "",
      prompt: "the body",
      keepCodingInstructions: true,
    });
  });

  test("non-object YAML is treated as no fields", async () => {
    await put(globalDir(), "scalar.md", "---\njust text\n---\nbody");
    expect((await discoverStyles({ project, env })).get("scalar")).toMatchObject({
      name: "scalar",
      prompt: "body",
    });
  });

  test("no frontmatter: whole content is the prompt", async () => {
    await put(globalDir(), "plain.md", "  just a prompt\nsecond line\n");
    expect((await discoverStyles({ project, env })).get("plain")).toMatchObject({
      name: "plain",
      prompt: "just a prompt\nsecond line",
    });
  });

  test("handles CRLF frontmatter", async () => {
    await put(globalDir(), "crlf.md", "---\r\nname: Win\r\ndescription: d\r\n---\r\nbody\r\n");
    expect((await discoverStyles({ project, env })).get("crlf")).toMatchObject({
      name: "Win",
      description: "d",
      prompt: "body",
    });
  });

  test("skips empty bodies and default.md", async () => {
    await put(globalDir(), "empty.md", "---\nname: Empty\n---\n  \n");
    await put(globalDir(), "default.md", "---\nname: Default\n---\nbody");
    const styles = await discoverStyles({ project, env });
    expect(styles.has("empty")).toBe(false);
    expect(styles.has("default")).toBe(false);
  });

  test("parses keep-coding-instructions and turn-reminder", async () => {
    await put(
      globalDir(),
      "a.md",
      "---\nkeep-coding-instructions: false\nturn-reminder: stay\n---\nbody",
    );
    await put(globalDir(), "b.md", '---\nkeep-coding-instructions: "false"\n---\nbody');
    await put(
      globalDir(),
      "c.md",
      "---\nkeep-coding-instructions: true\nturn-reminder: 5\n---\nbody",
    );
    const styles = await discoverStyles({ project, env });
    expect(styles.get("a")).toMatchObject({ keepCodingInstructions: false, turnReminder: "stay" });
    expect(styles.get("b")?.keepCodingInstructions).toBe(false);
    expect(styles.get("c")?.keepCodingInstructions).toBe(true);
    expect(styles.get("c")?.turnReminder).toBeUndefined();
  });

  test("builtinDir option replaces the bundled directory", async () => {
    const builtinDir = join(root, "custom-builtin");
    await put(builtinDir, "only.md", "body");
    const styles = await discoverStyles({ project, env, builtinDir });
    expect([...styles.keys()]).toEqual(["only"]);
  });
});

describe("findStyle", () => {
  test("matches id or name case-insensitively, id first", async () => {
    await put(globalDir(), "x.md", "---\nname: Pretty Name\n---\nbody");
    await put(globalDir(), "pretty name.md", "---\nname: Other\n---\nbody");
    const styles = await discoverStyles({ project, env });
    expect(findStyle(styles, "CONCISE")?.id).toBe("concise");
    expect(findStyle(styles, "  pretty NAME ")?.id).toBe("pretty name");
    expect(findStyle(styles, "other")?.id).toBe("pretty name");
    expect(findStyle(styles, "x")?.name).toBe("Pretty Name");
  });

  test("unknown or empty query is undefined", async () => {
    const styles = await discoverStyles({ project, env });
    expect(findStyle(styles, "nope")).toBeUndefined();
    expect(findStyle(styles, "")).toBeUndefined();
    expect(findStyle(styles, "   ")).toBeUndefined();
  });
});
