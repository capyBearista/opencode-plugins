import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AutoAdvisorRpc, type Status } from "./rpc.js";

/** How long the footer keeps showing a finished review. */
export const FINISHED_MS = 2_500;
const PANEL_MAX_LINES = 8;

type View = "reviewing" | "finished" | "failed" | "idle";

interface Envelope {
  readonly data?: Status;
}

// The JSON-schema RPC definition carries no static output types.
interface Client {
  status(input: { sessionID: string }, options?: unknown): Promise<Status>;
  readonly events: {
    on(
      name: "review.started" | "review.finished",
      handler: (envelope: Envelope) => void,
    ): () => void;
  };
}

export function footerText(view: View, latest: Status["latest"]): string {
  if (view === "reviewing") return "Advisor reviewing…";
  if (view === "failed") return "Advisor unavailable";
  if (view === "finished") return `✓ Advisor reviewed${latest ? ` (${latest.moment})` : ""}`;
  return "";
}

export function panelText(latest: Status["latest"]): string {
  if (!latest) return "";
  const lines = latest.advice.split("\n");
  const shown = lines.slice(0, PANEL_MAX_LINES);
  if (lines.length > PANEL_MAX_LINES) shown.push("…");
  return [`Advisor review (${latest.moment})`, ...shown].join("\n");
}

export default Plugin.define({
  id: "capybearista.opencode-auto-advisor.tui",
  setup(context) {
    const client = context.client.rpc(AutoAdvisorRpc) as unknown as Client;
    const [views, setViews] = createSignal<Record<string, View>>({});
    // Only reviews delivered while this TUI runs are shown; an old one after restart is noise.
    const [reviews, setReviews] = createSignal<Record<string, Status["latest"]>>({});
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // The entry id when each consult started: a finished consult is new only if it changed.
    const before = new Map<string, string | undefined>();

    const setView = (sessionID: string, view: View) =>
      setViews((known) => ({ ...known, [sessionID]: view }));

    const offStarted = client.events.on("review.started", ({ data }) => {
      if (!data) return;
      before.set(data.sessionID, data.latest?.id);
      setView(data.sessionID, "reviewing");
    });
    const offFinished = client.events.on("review.finished", ({ data }) => {
      if (!data) return;
      // A consult that delivered nothing (stale, or no new entry) leaves the latest id unchanged.
      const fresh = Boolean(data.latest) && data.latest?.id !== before.get(data.sessionID);
      before.delete(data.sessionID);
      const view: View = data.failed ? "failed" : fresh ? "finished" : "idle";
      setView(data.sessionID, view);
      if (fresh) setReviews((known) => ({ ...known, [data.sessionID]: data.latest }));
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (views()[data.sessionID] === view) setView(data.sessionID, "idle");
      }, FINISHED_MS);
      timers.add(timer);
    });

    const text = (content: () => string, color: () => unknown) => {
      const node = createElement("text");
      spread(
        node,
        {
          get fg() {
            return color();
          },
        },
        true,
      );
      insert(node, content);
      return node;
    };

    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render(input) {
        const view = () => (input.sessionID ? (views()[input.sessionID] ?? "idle") : "idle");
        const latest = () => (input.sessionID ? (reviews()[input.sessionID] ?? null) : null);
        return text(
          () => footerText(view(), latest()),
          () => (view() === "failed" ? context.theme.text.muted : context.theme.text.base),
        ) as unknown as JSX.Element;
      },
    });

    const unregisterPanel = context.ui.slot({
      append: "session.composer.top",
      render(input) {
        const box = createElement("box");
        const line = text(
          () => panelText(reviews()[input.sessionID] ?? null),
          () => context.theme.text.muted,
        );
        insert(box, () => (reviews()[input.sessionID] ? line : null));
        return box as unknown as JSX.Element;
      },
    });

    return () => {
      offStarted();
      offFinished();
      for (const timer of timers) clearTimeout(timer);
      unregisterFooter();
      unregisterPanel();
    };
  },
});
