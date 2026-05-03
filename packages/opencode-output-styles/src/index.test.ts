import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import plugin from "./index.js";

const STYLE_FILE = `---
name: "Pirate Style"
description: "Talks like a pirate"
---
# Pirate
You must respond like a swashbuckling pirate.`;

type Hooks = Awaited<ReturnType<typeof plugin.server>>;

let projectDir = "";
let hooks: Hooks;
let promptMock = mock();

function createMockCtx() {
  return {
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: promptMock,
      },
    },
  } as never;
}

async function writeStyle(id = "pirate") {
  const styleDir = path.join(projectDir, ".opencode", "output-styles");
  await fs.mkdir(styleDir, { recursive: true });
  await fs.writeFile(path.join(styleDir, `${id}.md`), STYLE_FILE);
}

async function writeActiveConfig(id: string) {
  await fs.mkdir(path.join(projectDir, ".opencode"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".opencode", "active-style.json"),
    JSON.stringify({ activeStyle: id }, null, 2),
  );
}

describe("@capybearista/opencode-output-styles", () => {
  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-output-styles-"));
    promptMock = mock();
    hooks = await plugin.server(createMockCtx());
  });

  afterEach(async () => {
    if (projectDir) {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  test("has an id", () => {
    expect(plugin.id).toBeString();
    expect(plugin.id).toBe("capybearista.opencode-output-styles");
  });

  test("exports a default object", () => {
    expect(plugin).toBeObject();
  });

  test("exports server hooks", () => {
    expect(plugin.server).toBeFunction();
  });

  test("injects the active output style wrapped in <output-style> tags", async () => {
    await writeStyle();
    await writeActiveConfig("pirate");

    const output = { system: ["Base prompt"] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output as never);

    expect(output.system).toHaveLength(2);
    expect(output.system[0]).toBe("Base prompt");
    expect(output.system[1]).toContain("<output-style>");
    expect(output.system[1]).toContain("You must respond like a swashbuckling pirate.");
    expect(output.system[1]).toContain("</output-style>");
  });

  test("injects the active output style into an empty system array", async () => {
    await writeStyle();
    await writeActiveConfig("pirate");

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output as never);

    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain("<output-style>");
    expect(output.system[0]).toContain("</output-style>");
  });

  test("does not rewrite existing system prompt text", async () => {
    await writeStyle();
    await writeActiveConfig("pirate");

    const basePrompt = "# Doing tasks\nKeep this section intact.";
    const output = { system: [basePrompt] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output as never);

    expect(output.system[0]).toBe(basePrompt);
    expect(output.system[1]).toContain("<output-style>");
  });

  test("/output-style command persists the selected style", async () => {
    await writeStyle();

    const output = { parts: [] };
    await expect(
      hooks["command.execute.before"]?.(
        { command: "output-style", arguments: "pirate", sessionID: "session-1" } as never,
        output as never,
      ),
    ).rejects.toThrow("__STYLE_COMMAND_HANDLED__");

    const saved = JSON.parse(
      await fs.readFile(path.join(projectDir, ".opencode", "active-style.json"), "utf-8"),
    );

    expect(saved).toEqual({ activeStyle: "pirate" });
    expect(promptMock).toHaveBeenCalled();
  });

  test("/output-style lists built-in styles when no user styles exist", async () => {
    const output = { parts: [] };
    await expect(
      hooks["command.execute.before"]?.(
        { command: "output-style", arguments: "", sessionID: "session-1" } as never,
        output as never,
      ),
    ).rejects.toThrow("__STYLE_COMMAND_HANDLED__");

    expect(promptMock).toHaveBeenCalled();
    const callArg = promptMock.mock.calls[0]?.[0];
    expect(callArg.body.parts[0].text).toContain("explanatory");
    expect(callArg.body.parts[0].text).toContain("learning");
    expect(callArg.body.parts[0].text).toContain("[Built-in]");
  });

  test("user style overrides built-in with the same ID", async () => {
    const overrideId = "explanatory";
    await writeStyle(overrideId);
    await writeActiveConfig(overrideId);

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output as never);

    expect(output.system[0]).toContain("<output-style>");
    expect(output.system[0]).toContain("swashbuckling pirate");
    expect(output.system[0]).toContain("</output-style>");
  });

  test("activates built-in style without any user style files", async () => {
    await writeActiveConfig("explanatory");

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({} as never, output as never);

    expect(output.system[0]).toContain("<output-style>");
    expect(output.system[0]).toContain("educational insights");
    expect(output.system[0]).toContain("</output-style>");
  });
});
