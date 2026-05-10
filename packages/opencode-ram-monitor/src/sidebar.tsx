import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { debugLog } from "./debug.js";
import { formatBytes, getLightweightRam, type LightweightRamResult } from "./memory.js";
import {
  getDefaultRefreshIntervalMs,
  getErrorMessage,
  loadRamMonitorWidgetConfig,
} from "./sidebar-config.js";

function createTextNode(
  props: Record<string, unknown>,
  content: string | null | (() => string | null),
) {
  const node = createElement("text");
  spread(node, props, true);
  insert(node, content);
  return node;
}

function createBoxNode(props: Record<string, unknown>, children: unknown[]) {
  const node = createElement("box");
  spread(node, props, true);
  for (const child of children) {
    insert(node, child);
  }
  return node;
}

function RamWidget(props: { api: TuiPluginApi }): JSX.Element {
  const [ram, setRam] = createSignal<LightweightRamResult>({ current: 0, total: 0, count: 0 });
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

  return createBoxNode({ gap: 0, padding: 1 }, [
    createTextNode(
      { fg: props.api.theme.current.text },
      () => `RAM Usage ${tick() % 2 === 0 ? "●" : "○"}`,
    ),
    createTextNode(
      { fg: () => (error() ? props.api.theme.current.error : props.api.theme.current.text) },
      () => (error() ? `Error: ${error()}` : `Current: ${formatBytes(ram().current)}`),
    ),
    createTextNode({ fg: props.api.theme.current.secondary }, () =>
      !error() && ram().count > 0
        ? `Total: ${formatBytes(ram().total)} (${ram().count} active)`
        : null,
    ),
    createTextNode({ fg: props.api.theme.current.error }, () => (error() ? null : warning())),
  ]) as JSX.Element;
}

const SIDEBAR_ORDER = 150;

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content() {
        return RamWidget({ api });
      },
    },
  });
};

const pluginModule: TuiPluginModule & { id: string } = {
  id: "capybearista.opencode-ram-monitor",
  tui,
};

export default pluginModule;
