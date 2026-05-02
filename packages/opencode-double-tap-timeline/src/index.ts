import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { useKeyboard } from "@opentui/solid";

const DOUBLE_PRESS_TIMEOUT_MS = 800;

export const tui: TuiPlugin = async (api) => {
  let lastEscPress = 0;
  let pendingDoubleTap = false;
  let doubleTapTimeout: ReturnType<typeof setTimeout> | undefined;

  api.lifecycle.onDispose(() => {
    if (doubleTapTimeout) clearTimeout(doubleTapTimeout);
  });

  api.slots.register({
    slots: {
      app() {
        useKeyboard((evt) => {
          if (evt.name !== "escape") return;

          const now = Date.now();
          const timeSinceLastPress = now - lastEscPress;

          if (timeSinceLastPress <= DOUBLE_PRESS_TIMEOUT_MS && pendingDoubleTap) {
            pendingDoubleTap = false;
            clearTimeout(doubleTapTimeout);
            lastEscPress = 0;

            if (api.ui.dialog.open) return;
            if (api.route.current.name !== "session") return;

            const sessionID = api.route.current.params?.sessionID as string | undefined;
            if (!sessionID) return;

            api.command.trigger("session.timeline");
            return;
          }

          pendingDoubleTap = true;
          lastEscPress = now;

          if (doubleTapTimeout) clearTimeout(doubleTapTimeout);
          doubleTapTimeout = setTimeout(() => {
            pendingDoubleTap = false;
          }, DOUBLE_PRESS_TIMEOUT_MS);
        });

        return null;
      },
    },
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "capybearista.opencode-double-tap-timeline",
  tui,
};

export default plugin;
