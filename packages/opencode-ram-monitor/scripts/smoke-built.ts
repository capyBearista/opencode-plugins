import "@opentui/solid/preload";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "@opencode/plugin/host";
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

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const entrypoints = resolve({ directory: packageDirectory });
assert(entrypoints.server === undefined, `unexpected server entry: ${entrypoints.server}`);
assert(entrypoints.tui, "no TUI entry resolves");
const tuiUrl = entrypoints.tui.startsWith("file:")
  ? entrypoints.tui
  : pathToFileURL(entrypoints.tui).href;
assert(basename(fileURLToPath(tuiUrl)) === "tui.js", `unexpected TUI entry: ${entrypoints.tui}`);

const tui = (await import(tuiUrl)) as { default: PluginDefinition };

assert(tui.default.id === "capybearista.opencode-ram-monitor", "tui id mismatch");
assert(typeof tui.default.setup === "function", "tui setup is not a function");

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

process.stdout.write("smoke: built TUI artifact loaded; no server entry resolves\n");
