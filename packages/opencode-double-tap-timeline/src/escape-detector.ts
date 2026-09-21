import type { Plugin } from "@opencode/plugin/tui";

const DOUBLE_PRESS_TIMEOUT_MS = 800;

type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>;
type EscapeEvent = { readonly name: string };
export type TimerHandle = ReturnType<typeof setTimeout> | number;

type EscapeDetectorOptions = {
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delay: number) => TimerHandle;
  readonly cancel?: (handle: TimerHandle) => void;
  readonly isModal: () => boolean;
  readonly currentRoute: () => Route;
  readonly dispatchTimeline: () => void;
};

export function createEscapeDetector(options: EscapeDetectorOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let lastEscPress = 0;
  let pendingDoubleTap = false;
  let pendingSessionID: string | undefined;
  let doubleTapTimeout: TimerHandle | undefined;
  let disposed = false;

  const reset = () => {
    pendingDoubleTap = false;
    lastEscPress = 0;
    pendingSessionID = undefined;
    if (doubleTapTimeout !== undefined) {
      cancel(doubleTapTimeout);
      doubleTapTimeout = undefined;
    }
  };

  const handle = (event: EscapeEvent) => {
    if (disposed || event.name !== "escape") return;

    if (options.isModal()) {
      reset();
      return;
    }

    const timestamp = now();
    const timeSinceLastPress = timestamp - lastEscPress;

    if (timeSinceLastPress <= DOUBLE_PRESS_TIMEOUT_MS && pendingDoubleTap) {
      const expectedSessionID = pendingSessionID;
      reset();

      const route = options.currentRoute();
      if (route.type !== "session" || route.sessionID !== expectedSessionID) return;

      options.dispatchTimeline();
      return;
    }

    const route = options.currentRoute();
    if (route.type !== "session" || !route.sessionID) {
      reset();
      return;
    }

    pendingDoubleTap = true;
    lastEscPress = timestamp;
    pendingSessionID = route.sessionID;

    if (doubleTapTimeout !== undefined) cancel(doubleTapTimeout);
    doubleTapTimeout = schedule(() => {
      pendingDoubleTap = false;
      lastEscPress = 0;
      pendingSessionID = undefined;
      doubleTapTimeout = undefined;
    }, DOUBLE_PRESS_TIMEOUT_MS);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    reset();
  };

  return { handle, dispose };
}
