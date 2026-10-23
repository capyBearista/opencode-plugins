import { describe, expect, test } from "bun:test";
import { getProcessDisplayLabel, isServerCommand, readPtyDaemonRuntimeDir } from "./command.js";

describe("isServerCommand", () => {
  test("recognizes managed, standalone, and npm-installed servers", () => {
    expect(isServerCommand("/home/a/.opencode/bin/opencode serve --service")).toBe(true);
    expect(
      isServerCommand("/usr/lib/node_modules/@opencode/cli/bin/opencode.exe serve --service"),
    ).toBe(true);
    expect(isServerCommand("opencode serve --stdio --port 0")).toBe(true);
    expect(isServerCommand('"C:\\Program Files\\opencode\\opencode.exe" serve --service')).toBe(
      true,
    );
  });

  test("rejects TUIs, other subcommands, and unrelated processes", () => {
    expect(isServerCommand("opencode")).toBe(false);
    expect(isServerCommand("opencode --standalone")).toBe(false);
    expect(isServerCommand("opencode run serve")).toBe(false);
    expect(isServerCommand("python3 -m http.server serve")).toBe(false);
    expect(isServerCommand("node /srv/app.js serve")).toBe(false);
    expect(isServerCommand("")).toBe(false);
  });
});

describe("readPtyDaemonRuntimeDir", () => {
  test("reads the runtime dir of a persistent-terminal daemon", () => {
    expect(
      readPtyDaemonRuntimeDir(
        "/home/a/.cache/opencode/bin/opencode-pty/1.0-abc/opencode-pty daemon --runtime-dir /home/a/.local/state/opencode/pty --name 1234",
      ),
    ).toBe("/home/a/.local/state/opencode/pty");
    expect(
      readPtyDaemonRuntimeDir(
        'C:\\opencode-pty\\opencode-pty.exe daemon --runtime-dir "C:\\Users\\a\\state\\pty" --name x',
      ),
    ).toBe("C:\\Users\\a\\state\\pty");
  });

  test("returns null for anything else", () => {
    expect(readPtyDaemonRuntimeDir("opencode-pty daemon --name x")).toBeNull();
    expect(readPtyDaemonRuntimeDir("opencode-pty attach --runtime-dir /tmp/x")).toBeNull();
    expect(readPtyDaemonRuntimeDir("bash --runtime-dir /tmp/x daemon")).toBeNull();
  });
});

describe("getProcessDisplayLabel", () => {
  test("labels OpenCode processes by role", () => {
    expect(getProcessDisplayLabel("/home/a/.opencode/bin/opencode serve --service")).toBe(
      "opencode serve",
    );
    expect(getProcessDisplayLabel("opencode")).toBe("opencode");
    expect(getProcessDisplayLabel("/x/opencode-pty daemon --runtime-dir /y --name z")).toBe(
      "opencode-pty",
    );
  });

  test("keeps runner subcommands and short interpreter names", () => {
    expect(getProcessDisplayLabel("/usr/bin/node /srv/mcp.js")).toBe("node");
    expect(getProcessDisplayLabel("uv tool uvx serena")).toBe("uv tool uvx");
    expect(getProcessDisplayLabel("npx -y @scope/mcp")).toBe("npx -y");
    expect(getProcessDisplayLabel("/usr/bin/clangd --background-index")).toBe("clangd");
  });
});
