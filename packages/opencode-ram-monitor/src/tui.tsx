import { createElement, createTextNode, insert, insertNode } from "@opentui/solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { formatBytes, getLightweightRam } from "./memory.js";

// biome-ignore lint/suspicious/noExplicitAny: TUI slot types are too restrictive
export function RamWidget(): any {
  const [ram, setRam] = createSignal<number>(0);

  onMount(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const poll = async () => {
      try {
        const currentRam = await getLightweightRam();
        if (!disposed) setRam(currentRam);
      } catch {
        // Ignore transient errors (e.g. permission denied on /proc)
      }

      if (!disposed) {
        timeout = setTimeout(poll, 3000);
      }
    };

    void poll();

    onCleanup(() => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
    });
  });

  // Manually construct the TUI element to avoid JSX transformation issues
  return (() => {
    const el = createElement("span");
    const textNode = createTextNode("RAM: ");
    insertNode(el, textNode);
    insert(el, () => formatBytes(ram()), null);
    return el;
  })();
}
