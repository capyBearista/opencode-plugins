import "@opentui/solid/preload";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "@opencode/plugin/host";

type PluginDefinition = {
  readonly id: string;
  readonly setup: (context: unknown) => Promise<unknown> | unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

async function load(entry: string | undefined, file: string): Promise<PluginDefinition> {
  assert(entry, `no ${file} entry resolves`);
  const url = entry.startsWith("file:") ? entry : pathToFileURL(entry).href;
  assert(basename(fileURLToPath(url)) === file, `unexpected entry: ${entry}`);
  const module = (await import(url)) as { default: PluginDefinition };
  assert(typeof module.default.setup === "function", `${file} setup is not a function`);
  return module.default;
}

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const entrypoints = resolve({ directory: packageDirectory });

const server = await load(entrypoints.server, "server.js");
assert(server.id === "capybearista.opencode-output-styles", "server id mismatch");

const registered: string[] = [];
const registration = { dispose: async () => {} };
const cleanup = await server.setup({
  options: {},
  location: { directory: packageDirectory, project: { directory: packageDirectory } },
  rpc: {
    register: async (definition: { id: string }) => {
      registered.push(`rpc:${definition.id}`);
      return registration;
    },
  },
  session: {
    hook: async (name: string) => {
      registered.push(`hook:${name}`);
      return registration;
    },
  },
  storage: {},
  agent: {},
});
assert(
  registered.join(",") === "rpc:output-styles,hook:context",
  `unexpected server registrations: ${registered.join(",")}`,
);
assert(typeof cleanup === "function", "server setup returns no cleanup");

const tui = await load(entrypoints.tui, "tui.js");
assert(tui.id === "capybearista.opencode-output-styles.tui", "tui id mismatch");

const slots: Array<{ append?: string }> = [];
const layers: unknown[] = [];
await tui.setup({
  client: {
    rpc: () => ({ state: async () => ({ styles: [], defaultStyle: null, sessionStyle: null }) }),
  },
  ui: {
    slot: (claim: { append?: string }) => {
      slots.push(claim);
      return () => {};
    },
    toast: { show: () => {} },
  },
  keymap: { layer: (input: unknown) => layers.push(input) },
  data: { on: () => () => {}, session: { get: () => undefined } },
  theme: { text: {} },
});
assert(slots.length === 1 && slots[0]?.append === "sidebar.content", "expected one sidebar slot");
assert(layers.length === 1, `expected one keymap layer, got ${layers.length}`);

process.stdout.write("smoke: built server and TUI entries loaded and registered\n");
