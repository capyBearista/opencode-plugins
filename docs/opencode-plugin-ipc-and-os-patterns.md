# OpenCode Plugin IPC and OS Interaction Patterns

This guide captures architectural principles and cross-platform interaction patterns derived from the development of ecosystem plugins (such as `opencode-ram-monitor`). It serves as a reference for plugin authors to ensure stability, responsiveness, and broad platform compatibility.

## 1. IPC and Asynchronous Initialization Constraints

OpenCode plugins operate across an IPC (Inter-Process Communication) boundary. When the OpenCode host boots, it synchronously queries registered plugins to build the UI and establish the plugin registry.

### The Top-Level `await` Trap
**Do not block the plugin factory with top-level `await`.**

When exporting a TUI plugin module, the factory function must return immediately. If you place a top-level `await` (e.g., fetching a configuration file or making an external API call) before returning the `api.slots.register` call, you block the IPC channel.

**Symptoms of a blocked IPC:**
- The OpenCode terminal renders a black screen or hangs indefinitely.
- The host is unable to proceed with rendering other widgets.

**The Solution:**
Defer asynchronous data loading to the UI lifecycle layer. Use SolidJS's `onMount` (or equivalent React hooks if using React) inside the actual widget component.

```tsx
// ❌ BAD: Blocks IPC during host boot
const tui: TuiPlugin = async (api) => {
  const config = await readConfig(); // DANGER: Host hangs waiting for this
  api.slots.register({ /* ... */ });
};

// ✅ GOOD: Returns immediately, loads async
const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        const [data, setData] = createSignal(null);
        onMount(async () => {
          const config = await readConfig();
          setData(config);
        });
        return <Widget data={data()} />;
      }
    }
  });
};
```

## 2. Platform-Specific OS Interaction Patterns

When a plugin needs to interact with the underlying OS (e.g., reading system metrics, managing processes, file system queries), relying on Node.js standard libraries alone is often insufficient. Below are proven patterns for robust cross-platform interactions.

### Linux and WSL: The `/proc` Fast Path
For system-level metrics on Linux and WSL environments, reading directly from the virtual `/proc` filesystem is highly performant and requires zero subprocess overhead.

- **Pattern:** Read `/proc/[pid]/status` directly.
- **Why:** Avoids `ps` command invocation overhead during rapid polling cycles. Perfectly maps over into WSL environments without requiring Windows interop bridging.

### macOS (Darwin): Command-Line Execution
macOS does not expose a `/proc` filesystem. To get similar metrics, you must shell out to BSD commands.

- **Pattern:** `ps -o rss= -p [pid]`
- **Safety:** Always wrap the `exec` call in a `try...catch` and execute isolated per-PID queries. Shelling out for a large batch of PIDs simultaneously can fail entirely if a single PID in the query string exits before execution completes.

### Windows (Pwsh/CMD): `wmic` and CSV Hazards
Windows querying using `wmic` or PowerShell introduces text-parsing hazards, particularly with command lines that include commas or nested quotes.

- **The CSV Bug:** Never use `wmic /format:csv`. If a process command line contains a comma, it breaks the CSV column alignment, leading to NaN errors and logic failures.
- **Pattern:** Use `wmic process get ... /format:value`.
- **Implementation:** This outputs `Key=Value` blocks separated by blank lines. It is vastly more resilient to commas in the data.

```ts
// Executing wmic with /format:value
const { stdout } = await execAsync(
  "wmic process get CommandLine,ProcessId /format:value",
  { windowsHide: true, timeout: 5000 }
);

// Splitting securely by block
const blocks = stdout.replace(/\r\n/g, "\n").trim().split(/\n\n+/);
// Parsing Key=Value inside the block
```

- **Hidden Windows:** Always pass `windowsHide: true` to `exec` or `spawn` options on Windows to prevent console windows from flashing dynamically when polling the system.

## 3. Polling and Process Lifecycle Hygiene

For plugins that implement continuous polling:

1. **Avoid `setInterval` Overlap:** Use recursive `setTimeout` instead of `setInterval`. If the asynchronous payload takes longer than the interval (e.g., a slow disk or CPU spike), `setInterval` will queue overlapping executions. Recursive `setTimeout` ensures the next tick only queues after the previous one finishes.
2. **Deterministic Cleanup:** Plugins can be unloaded or the TUI can be re-mounted. Always track a `disposed` boolean flag and clear timeouts inside `onCleanup` hooks to prevent memory leaks and zombie loops.