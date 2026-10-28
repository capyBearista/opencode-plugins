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
// One opencode.json(c) entry must resolve both halves; nothing goes in cli.json.
const entrypoints = resolve({ directory: packageDirectory });

const server = await load(entrypoints.server, "server.js");
assert(server.id === "capybearista.opencode-auto-advisor", "server id mismatch");

const registered: string[] = [];
const registration = { dispose: async () => {}, events: { emit: () => {} } };
const cleanup = await server.setup({
  experimental: { generate: { decisions: async () => ({}), text: async () => ({ text: "" }) } },
  rpc: {
    register: async (definition: { id: string }) => {
      registered.push(`rpc:${definition.id}`);
      return registration;
    },
  },
  tool: {
    transform: async (fn: (editor: { add: (tool: { name: string }) => void }) => void) => {
      fn({ add: (tool) => registered.push(`tool:${tool.name}`) });
      return registration;
    },
  },
  session: {
    hook: async (name: string) => {
      registered.push(`hook:${name}`);
      return registration;
    },
  },
  event: {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
      }),
    }),
  },
});
assert(
  registered.join(",") === "rpc:auto-advisor,tool:advisor,hook:prompt,hook:context",
  `unexpected server registrations: ${registered.join(",")}`,
);
assert(typeof cleanup === "function", "server setup returns no cleanup");
await (cleanup as () => Promise<void>)();

const tui = await load(entrypoints.tui, "tui.js");
assert(tui.id === "capybearista.opencode-auto-advisor.tui", "tui id mismatch");

const slots: string[] = [];
await tui.setup({
  client: { rpc: () => ({ events: { on: () => () => {} } }) },
  ui: {
    slot: (claim: { append: string }) => {
      slots.push(claim.append);
      return () => {};
    },
  },
  theme: { text: {} },
});
assert(
  slots.join(",") === "prompt.footer.status,session.composer.top",
  `unexpected TUI slots: ${slots.join(",")}`,
);

process.stdout.write("smoke: built server and TUI entries loaded and registered\n");
