import "@opentui/solid/preload";
import { createRoot } from "solid-js";

type PluginDefinition = {
  readonly id: string;
  readonly setup: (context: unknown) => Promise<void> | void;
};

type SlotClaim = {
  readonly append?: string;
  readonly after?: string;
  readonly render: (input: unknown) => unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

const server = (await import(new URL("../server.js", import.meta.url).href)) as {
  default: PluginDefinition;
};
const tui = (await import(new URL("../tui.js", import.meta.url).href)) as {
  default: PluginDefinition;
};

assert(server.default.id === "capybearista.opencode-ram-monitor", "server id mismatch");
assert(typeof server.default.setup === "function", "server setup is not a function");
assert(tui.default.id === "capybearista.opencode-ram-monitor", "tui id mismatch");
assert(typeof tui.default.setup === "function", "tui setup is not a function");

const commandNames: string[] = [];
await server.default.setup({
  command: {
    transform: async (
      callback: (editor: { add: (definition: { name: string }) => void }) => void,
    ) => {
      callback({
        add: (definition) => {
          commandNames.push(definition.name);
        },
      });
    },
  },
  session: { synthetic: async () => {} },
});
assert(commandNames.length === 1, `expected one command, got ${commandNames.length}`);
assert(commandNames[0] === "ram", `unexpected command: ${commandNames[0]}`);

const slots: SlotClaim[] = [];
const layers: Array<() => unknown> = [];
const context = {
  ui: {
    slot: (claim: SlotClaim) => {
      slots.push(claim);
      return () => {};
    },
    dialog: {
      set: () => {},
      show: () => {},
      clear: () => {},
    },
  },
  keymap: {
    layer: (input: () => unknown) => {
      layers.push(input);
    },
  },
  theme: {},
  location: { directory: process.cwd() },
};

await tui.default.setup(context);
assert(slots.length === 2, `unexpected slot count: ${slots.length}`);
assert(slots[0]?.append === "sidebar.content", `unexpected first slot target: ${slots[0]?.append}`);
assert(slots[1]?.append === "app", `unexpected second slot target: ${slots[1]?.append}`);

const appSlot = slots.find((slot) => slot.append === "app");
assert(appSlot, "app slot was not registered");

const dispose = createRoot((dispose) => {
  appSlot.render({});
  return dispose;
});
dispose();
assert(layers.length === 1, `expected one keymap layer, got ${layers.length}`);

process.stdout.write("smoke: built server and TUI artifacts loaded\n");
