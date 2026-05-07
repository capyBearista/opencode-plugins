/** @jsxImportSource @opentui/solid */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { formatBytes, getLightweightRam, type LightweightRamResult } from "./memory.js";
import {
  getDefaultRefreshIntervalMs,
  getErrorMessage,
  normalizeRefreshIntervalMs,
} from "./sidebar-config.js";

function RamWidget(props: { api: TuiPluginApi }) {
  const [ram, setRam] = createSignal<LightweightRamResult>({ current: 0, total: 0, count: 0 });
  const [error, setError] = createSignal<string | null>(null);
  const [intervalMs, setIntervalMs] = createSignal<number>(getDefaultRefreshIntervalMs());
  const [tick, setTick] = createSignal(0);

  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  // Fetch config once on mount
  const loadConfig = async () => {
    try {
      const worktree = props.api.state.path?.worktree || process.cwd();
      const configPath = path.join(worktree, ".opencode", "opencode.json");
      const configContent = await fs.readFile(configPath, "utf8");

      // Basic JSON parsing. Real parser would strip comments, but since
      // comments break strict JSON anyway, we just try parse.
      const parsed = JSON.parse(configContent);
      const rawConfig = parsed?.experimental?.ramMonitor;

      if (rawConfig && "refreshIntervalMs" in rawConfig) {
        const nextInterval = normalizeRefreshIntervalMs(rawConfig.refreshIntervalMs);
        setIntervalMs(nextInterval);
      }
    } catch {
      // Keep default interval if file missing or invalid.
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

  return (
    <box gap={0} padding={1}>
      <text fg={props.api.theme.current.text}>
        <b>RAM Usage</b> {tick() % 2 === 0 ? "●" : "○"}
      </text>
      <text fg={error() ? props.api.theme.current.error : props.api.theme.current.text}>
        {error() ? `Error: ${error()}` : `Current: ${formatBytes(ram().current)}`}
      </text>
      {!error() && ram().count > 0 && (
        <text fg={props.api.theme.current.secondary}>
          {`Total: ${formatBytes(ram().total)} (${ram().count} active)`}
        </text>
      )}
    </box>
  );
}

const SIDEBAR_ORDER = 150;

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content() {
        return <RamWidget api={api} />;
      },
    },
  });
};

const pluginModule: TuiPluginModule & { id: string } = {
  id: "capybearista.opencode-ram-monitor",
  tui,
};

export default pluginModule;
