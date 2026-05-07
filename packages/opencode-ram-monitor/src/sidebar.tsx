/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup } from "solid-js";
import { formatBytes, getLightweightRam, type LightweightRamResult } from "./memory.js";

function RamWidget(props: { api: TuiPluginApi }) {
  const [ram, setRam] = createSignal<LightweightRamResult>({ current: 0, total: 0, count: 0 });
  const [error, setError] = createSignal<string | null>(null);
  const [intervalMs, setIntervalMs] = createSignal<number>(5000);

  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  // Fetch config once on mount
  const loadConfig = async () => {
    try {
      const response = await props.api.client.config.get();
      const rawConfig = (
        response.data as unknown as { experimental?: { ramMonitor?: Record<string, unknown> } }
      )?.experimental?.ramMonitor;
      if (rawConfig?.refreshIntervalMs) {
        setIntervalMs(Number(rawConfig.refreshIntervalMs) || 5000);
      }
    } catch {
      // fallback to 5000
    }
  };
  void loadConfig();

  const poll = async () => {
    try {
      const currentRam = await getLightweightRam();
      if (!disposed) {
        setRam(currentRam);
        setError(null);
      }
    } catch (err: unknown) {
      if (!disposed) {
        setError((err as Error).message || "RAM error");
        console.error("RAM Monitor Poll Error:", err);
      }
    }

    if (!disposed) {
      timeout = setTimeout(poll, intervalMs());
    }
  };

  void poll();

  onCleanup(() => {
    disposed = true;
    if (timeout) clearTimeout(timeout);
  });

  return (
    <box gap={0} padding={1}>
      <text fg={props.api.theme.current.text}>
        <b>RAM Usage</b>
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
  console.log("RamMonitor TUI plugin loading with ID: capybearista.opencode-ram-monitor");

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
