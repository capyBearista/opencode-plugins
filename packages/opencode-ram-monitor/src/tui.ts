import { Plugin } from "@opencode/plugin/tui";
import { SyntaxStyle } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createComponent, createSignal, onCleanup, onMount } from "solid-js";
import { debugLog } from "./debug.js";
import {
  formatBytes,
  getHeavyProcessTree,
  getLightweightRam,
  type LightweightRamResult,
} from "./memory.js";
import {
  getDefaultRefreshIntervalMs,
  getErrorMessage,
  loadRamMonitorWidgetConfig,
} from "./sidebar-config.js";
import { processSnapshotCache } from "./snapshot.js";
import { readRamWidgetTheme } from "./theme.js";

type NodePropValue = unknown | (() => unknown);
type TuiContext = Plugin.Context;

const MODAL_MAX_HEIGHT = 24;

function isEventProp(key: string): boolean {
  return key.startsWith("on") && key.length > 2 && key[2] === key[2]?.toUpperCase();
}

function createRenderableProps(props: Record<string, NodePropValue>): Record<string, unknown> {
  const reactiveProps: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(reactiveProps, key, {
      enumerable: true,
      get: () =>
        typeof value === "function" && !isEventProp(key) ? (value as () => unknown)() : value,
    });
  }

  return reactiveProps;
}

function createTextNode(
  props: Record<string, NodePropValue>,
  content: string | null | (() => string | null),
): JSX.Element {
  const node = createElement("text");
  spread(node, createRenderableProps(props), true);
  insert(node, content);
  return node as unknown as JSX.Element;
}

function createContainerNode(
  tag: string,
  props: Record<string, NodePropValue>,
  children: unknown[],
): JSX.Element {
  const node = createElement(tag);
  spread(node, createRenderableProps(props), true);
  for (const child of children) {
    insert(node, child);
  }
  return node as unknown as JSX.Element;
}

function formatRamRow(label: string, direct: number, withTools: number): string {
  return `${label.padEnd(4)} ${formatBytes(direct).padStart(10)} | ${formatBytes(withTools).padStart(10)}`;
}

function formatRamHeaderLeft(flash: string): string {
  return `RAM Usage ${flash}`;
}

function formatRamHeaderRight(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

// A plugin cannot reach the host's syntax style, so mirror the markdown
// subset of the host's generator from the plugin-visible theme tokens.
function createMarkdownSyntaxStyle(theme: TuiContext["theme"]): SyntaxStyle {
  const { markdown } = theme;
  return SyntaxStyle.fromTheme([
    {
      scope: [
        "markup.heading",
        "markup.heading.2",
        "markup.heading.3",
        "markup.heading.4",
        "markup.heading.5",
        "markup.heading.6",
      ],
      style: { foreground: markdown.heading, bold: true },
    },
    {
      scope: ["markup.heading.1"],
      style: { foreground: markdown.heading, bold: true, underline: true },
    },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: markdown.strong, bold: true } },
    { scope: ["markup.italic"], style: { foreground: markdown.emphasis, italic: true } },
    {
      scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"],
      style: { foreground: markdown.code },
    },
    { scope: ["markup.list"], style: { foreground: markdown.listItem } },
    { scope: ["markup.quote"], style: { foreground: markdown.blockQuote, italic: true } },
    {
      scope: ["markup.link", "markup.link.url"],
      style: { foreground: markdown.link, underline: true },
    },
    {
      scope: ["markup.link.label"],
      style: { foreground: markdown.linkText, underline: true },
    },
    { scope: ["markup.strikethrough"], style: { foreground: theme.text.muted } },
  ]);
}

function RamWidget(props: { context: TuiContext; onOpen: () => void }): JSX.Element {
  const theme = () => readRamWidgetTheme(props.context.theme);
  const worktree = () => props.context.location?.directory ?? process.cwd();
  const [ram, setRam] = createSignal<LightweightRamResult>({
    thisDirect: 0,
    thisWithTools: 0,
    allDirect: 0,
    allWithTools: 0,
    count: 0,
  });
  const [error, setError] = createSignal<string | null>(null);
  const [intervalMs, setIntervalMs] = createSignal<number>(getDefaultRefreshIntervalMs());
  const [tick, setTick] = createSignal(0);
  const [warning, setWarning] = createSignal<string | null>(null);

  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const loadConfig = async () => {
    const config = await loadRamMonitorWidgetConfig(worktree(), props.context.options);
    setIntervalMs(config.intervalMs);
    processSnapshotCache.setTtlMs(config.intervalMs);
    setWarning(config.warning ? `Config warning: using ${config.intervalMs}ms fallback` : null);

    if (config.warning) {
      await debugLog("sidebar-config-fallback", {
        appliedConfigPath: config.sourcePath || "unknown",
        failedConfigPath: config.warningPath || "unknown",
        error: config.warning,
        fallbackIntervalMs: config.intervalMs,
      });
    }
  };

  const poll = async () => {
    try {
      const currentRam = await getLightweightRam();
      if (!disposed) {
        setRam(currentRam);
        setError(null);
        setTick((t) => t + 1);
      }
    } catch (err: unknown) {
      await debugLog("sidebar-poll-failed", {
        worktree: worktree(),
        intervalMs: intervalMs(),
        error: getErrorMessage(err),
      });
      if (!disposed) {
        setError(getErrorMessage(err));
      }
    }

    if (!disposed) {
      timeout = setTimeout(poll, intervalMs());
    }
  };

  onMount(() => {
    void (async () => {
      await loadConfig();
      if (!disposed) {
        void poll();
      }
    })();
  });

  onCleanup(() => {
    disposed = true;
    if (timeout) clearTimeout(timeout);
  });

  return createContainerNode(
    "box",
    {
      border: true,
      borderStyle: "rounded",
      borderColor: () =>
        error() ? theme().error : warning() ? theme().warning : theme().borderSubtle,
      backgroundColor: () => theme().backgroundElement,
      gap: 0,
      paddingLeft: 1,
      paddingRight: 1,
      onMouseUp: () => {
        props.onOpen();
      },
    },
    [
      createContainerNode(
        "box",
        { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
        [
          createTextNode(
            {
              fg: () => (error() ? theme().error : warning() ? theme().warning : theme().success),
            },
            () => formatRamHeaderLeft(tick() % 2 === 0 ? "●" : "○"),
          ),
          createTextNode(
            {
              fg: () => theme().secondary,
              flexShrink: 0,
              wrapMode: "none",
              truncate: true,
            },
            () => formatRamHeaderRight(ram().count),
          ),
        ],
      ),
      createTextNode(
        {
          fg: () => theme().textMuted,
        },
        () => "      direct      with tools",
      ),
      createTextNode({ fg: () => (error() ? theme().error : theme().text) }, () =>
        error() ? `Error: ${error()}` : formatRamRow("This", ram().thisDirect, ram().thisWithTools),
      ),
      createTextNode({ fg: () => (error() ? theme().error : theme().secondary) }, () =>
        !error() ? formatRamRow("All", ram().allDirect, ram().allWithTools) : null,
      ),
      createTextNode({ fg: () => theme().textMuted }, () =>
        !error() ? "/ram includes tools" : warning() ? warning() : null,
      ),
    ],
  );
}

function RamModal(props: { context: TuiContext }): JSX.Element {
  const theme = () => readRamWidgetTheme(props.context.theme);
  const syntaxStyle = createMarkdownSyntaxStyle(props.context.theme);
  const [tree, setTree] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  let disposed = false;

  void getHeavyProcessTree()
    .then((text) => {
      if (!disposed) setTree(text);
    })
    .catch((cause: unknown) => {
      if (!disposed) setError(getErrorMessage(cause));
    });

  onCleanup(() => {
    disposed = true;
    void props.context.renderer
      .idle()
      .catch(() => {})
      .finally(() => syntaxStyle.destroy());
  });

  const body = () => {
    if (error()) return `Error: ${error()}`;
    return tree() ?? "Loading RAM usage...";
  };

  return createContainerNode(
    "box",
    { flexDirection: "column", gap: 1, paddingLeft: 2, paddingRight: 2, paddingBottom: 1 },
    [
      createTextNode(
        { fg: () => theme().text, wrapMode: "none", truncate: true },
        () => "RAM Usage",
      ),
      createContainerNode(
        "scrollbox",
        {
          maxHeight: MODAL_MAX_HEIGHT,
          scrollX: true,
          scrollY: true,
          contentOptions: { minHeight: 0 },
          scrollbarOptions: { visible: false },
        },
        [
          createContainerNode(
            "markdown",
            {
              content: body,
              fg: () => (error() ? theme().error : theme().text),
              syntaxStyle,
              internalBlockMode: "top-level",
            },
            [],
          ),
        ],
      ),
      // Escape is handled by the host dialog's modal keymap layer; the hint
      // only adds a pointer target for closing without the keyboard.
      createTextNode(
        {
          fg: () => theme().textMuted,
          onMouseUp: () => {
            props.context.ui.dialog.clear();
          },
        },
        () => "esc to close",
      ),
    ],
  );
}

function openRamModal(context: TuiContext): void {
  const dialog = context.ui.dialog;
  // show() replaces the dialog stack, so clearing first keeps repeat opens
  // idempotent; set() must follow show() because show() resets the size.
  dialog.clear();
  dialog.show(() => createComponent(RamModal, { context }));
  dialog.set({ size: "xlarge" });
}

export default Plugin.define({
  id: "capybearista.opencode-ram-monitor",
  setup(context) {
    const unregisterSidebar = context.ui.slot({
      // `after` is the only ordering lever in the V2 slot API: it renders this
      // claim after every contribution inside `sidebar.content`, so the widget
      // follows the built-in Context/MCP panels instead of leading them.
      after: "sidebar.content",
      render() {
        return createComponent(RamWidget, { context, onOpen: () => openRamModal(context) });
      },
    });

    // context.keymap.layer creates a layer owned by the calling component, so
    // it cannot run in setup scope; the always-mounted "app" slot supplies
    // that component. The flag keeps duplicate app mounts or repeated renders
    // from stacking layers, and onCleanup lets a remount re-register.
    let commandLayerRegistered = false;

    const unregisterCommand = context.ui.slot({
      append: "app",
      render() {
        if (commandLayerRegistered) return null;
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "ram.open",
              title: "RAM usage",
              description: "Open the RAM usage panel",
              group: "RAM",
              palette: true,
              slash: { name: "ram", arguments: true },
              run: () => {
                openRamModal(context);
              },
            },
          ],
        }));
        commandLayerRegistered = true;
        onCleanup(() => {
          commandLayerRegistered = false;
        });
        return null;
      },
    });

    return () => {
      unregisterSidebar();
      unregisterCommand();
    };
  },
});
