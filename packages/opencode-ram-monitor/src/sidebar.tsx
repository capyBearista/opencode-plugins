import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createComponent, createSignal, onCleanup, onMount } from "solid-js";
import { debugLog } from "./debug.js";
import { formatBytes, getLightweightRam, type LightweightRamResult } from "./memory.js";
import {
  getDefaultRefreshIntervalMs,
  getErrorMessage,
  loadRamMonitorWidgetConfig,
} from "./sidebar-config.js";
import { processSnapshotCache } from "./snapshot.js";

type NodePropValue = unknown | (() => unknown);

function createRenderableProps(props: Record<string, NodePropValue>): Record<string, unknown> {
  const reactiveProps: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(reactiveProps, key, {
      enumerable: true,
      get: () => (typeof value === "function" ? (value as () => unknown)() : value),
    });
  }

  return reactiveProps;
}

function createTextNode(
  props: Record<string, NodePropValue>,
  content: string | null | (() => string | null),
) {
  const node = createElement("text");
  spread(node, createRenderableProps(props), true);
  insert(node, content);
  return node;
}

function createBoxNode(props: Record<string, NodePropValue>, children: unknown[]) {
  const node = createElement("box");
  spread(node, createRenderableProps(props), true);
  for (const child of children) {
    insert(node, child);
  }
  return node;
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

function RamWidget(props: { api: TuiPluginApi }): JSX.Element {
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
    const worktree = props.api.state.path?.worktree || process.cwd();
    const config = await loadRamMonitorWidgetConfig(worktree);
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
        worktree: props.api.state.path?.worktree || process.cwd(),
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

  return createBoxNode(
    {
      border: true,
      borderStyle: "rounded",
      borderColor: () =>
        error()
          ? props.api.theme.current.error
          : warning()
            ? props.api.theme.current.warning
            : props.api.theme.current.borderSubtle,
      backgroundColor: () => props.api.theme.current.backgroundElement,
      gap: 0,
      padding: 1,
    },
    [
      createBoxNode(
        { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
        [
          createTextNode(
            {
              fg: () =>
                error()
                  ? props.api.theme.current.error
                  : warning()
                    ? props.api.theme.current.warning
                    : props.api.theme.current.success,
            },
            () => formatRamHeaderLeft(tick() % 2 === 0 ? "●" : "○"),
          ),
          createTextNode(
            {
              fg: () => props.api.theme.current.secondary,
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
          fg: () => props.api.theme.current.textMuted,
        },
        () => "      direct      with tools",
      ),
      createTextNode(
        { fg: () => (error() ? props.api.theme.current.error : props.api.theme.current.text) },
        () =>
          error()
            ? `Error: ${error()}`
            : formatRamRow("This", ram().thisDirect, ram().thisWithTools),
      ),
      createTextNode(
        { fg: () => (error() ? props.api.theme.current.error : props.api.theme.current.secondary) },
        () => (!error() ? formatRamRow("All", ram().allDirect, ram().allWithTools) : null),
      ),
      createTextNode({ fg: () => props.api.theme.current.textMuted }, () =>
        !error() ? "/ram includes tools" : warning() ? warning() : null,
      ),
    ],
  ) as JSX.Element;
}

const SIDEBAR_ORDER = 150;

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content() {
        return createComponent(RamWidget, { api });
      },
    },
  });
};

const pluginModule: TuiPluginModule & { id: string } = {
  id: "capybearista.opencode-ram-monitor",
  tui,
};

export default pluginModule;
