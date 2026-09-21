import { Plugin } from "@opencode/plugin/tui";
import { useKeyboard } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { createEscapeDetector } from "./escape-detector.js";

const plugin = Plugin.define({
  id: "capybearista.opencode-double-tap-timeline",
  setup(context) {
    const activeDetectors = new Set<ReturnType<typeof createEscapeDetector>>();
    let disposed = false;
    const unregister = context.ui.slot({
      append: "app",
      render() {
        if (disposed) return null;

        const detector = createEscapeDetector({
          isModal: () => context.keymap.mode.current() === "modal",
          currentRoute: () => context.ui.router.current(),
          dispatchTimeline: () => context.keymap.dispatch("session.timeline"),
        });

        activeDetectors.add(detector);
        useKeyboard(detector.handle);
        onCleanup(() => {
          detector.dispose();
          activeDetectors.delete(detector);
        });
        return null;
      },
    });

    return () => {
      if (disposed) return;
      disposed = true;
      for (const detector of activeDetectors) detector.dispose();
      activeDetectors.clear();
      unregister();
    };
  },
});

export default plugin;
