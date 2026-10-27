import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Host } from "@opencode/plugin/host";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = (entry) => pathToFileURL(path.join(root, entry)).href;

test("Host.resolve maps the local package directory through its exports without a server entrypoint", () => {
  assert.deepEqual(Host.resolve({ directory: root }), {
    server: undefined,
    tui: url("dist/index.js"),
    rpc: undefined,
    gui: undefined,
  });
});

test("Host.resolve keeps the built directory server-only", () => {
  assert.deepEqual(Host.resolve({ directory: path.join(root, "dist") }), {
    server: url("dist/index.js"),
    tui: undefined,
    rpc: undefined,
    gui: undefined,
  });
});

test("Host.resolve keeps the named package TUI export mapped to dist/index.js", () => {
  assert.deepEqual(
    Host.resolve({
      directory: root,
      name: "@capybearista/opencode-double-tap-timeline",
    }),
    {
      server: undefined,
      tui: url("dist/index.js"),
      rpc: undefined,
      gui: undefined,
    },
  );
});
