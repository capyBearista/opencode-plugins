import { Plugin } from "@opencode/plugin/tui";
import { SyntaxStyle } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { AutoAdvisorRpc, type Status } from "./rpc.js";

/** How long the footer keeps showing a finished review. */
export const FINISHED_MS = 2_500;
/** The `session.panel` name this plugin opens and renders. */
export const PANEL = "auto-advisor";

type View = "reviewing" | "finished" | "failed" | "idle";
type Latest = Status["latest"];
type Context = Plugin.Context;
/** The fields used from the host's `session.panel` input (not exported by `@opencode/plugin`). */
interface PanelInput {
  readonly name: string;
  readonly sessionID: string;
  readonly focused: boolean;
  readonly close: () => void;
  readonly toggleFullscreen: () => void;
}

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

export function footerText(view: View, latest: Latest): string {
  if (view === "reviewing") return "Advisor reviewing…";
  if (view === "failed") return "Advisor unavailable";
  if (view === "finished") return `✓ Advisor reviewed${latest ? ` (${latest.moment})` : ""}`;
  return "";
}

const clock = (iso: string) => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** The sidebar widget's status, right of "Advisor". */
export function sidebarStatus(view: View, latest: Latest, mode: Status["mode"]): string {
  if (view === "reviewing") return "reviewing…";
  if (view === "failed") return "unavailable";
  if (latest) return `✓ ${latest.moment}${latest.details ? ` ${clock(latest.details.at)}` : ""}`;
  return mode === "active" ? "no review yet" : mode;
}

/** The panel's one-line summary above the advice. */
export function panelSummary(latest: Latest): string {
  if (!latest) return "No automatic review in this session yet.";
  const details = latest.details
    ? `${latest.details.model} · ${(latest.details.ms / 1000).toFixed(1)} s · ${clock(latest.details.at)}`
    : "delivered before OpenCode restarted";
  return `Moment: ${latest.moment} · ${details}`;
}

type Prop = unknown | (() => unknown);

const isEvent = (key: string) => key.startsWith("on") && key[2] === key[2]?.toUpperCase();

/** Function props are read reactively, except event handlers. */
const reactive = (props: Record<string, Prop>) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () =>
        typeof value === "function" && !isEvent(key) ? (value as () => unknown)() : value,
    });
  }
  return out;
};

/**
 * Leave `children` out for an element that builds its own children: inserting even an empty list
 * into `markdown` removes the blocks it rendered from `content`, so it stays blank in the host.
 */
function node(tag: string, props: Record<string, Prop>, children?: unknown): JSX.Element {
  const element = createElement(tag);
  spread(element, reactive(props), true);
  if (children !== undefined) insert(element, children);
  return element as unknown as JSX.Element;
}

// A plugin cannot reach the host's syntax style, so mirror the markdown subset of the host's
// generator (`theme/src/tui/syntax.ts`) from the plugin-visible theme tokens.
function markdownStyle(theme: Context["theme"], owner: Context["renderer"]["nativeScene"]) {
  const { markdown } = theme;
  return SyntaxStyle.fromTheme(
    [
      {
        scope: ["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4"],
        style: { foreground: markdown.heading, bold: true },
      },
      {
        scope: ["markup.heading.1"],
        style: { foreground: markdown.heading, bold: true, underline: true },
      },
      {
        scope: ["markup.bold", "markup.strong"],
        style: { foreground: markdown.strong, bold: true },
      },
      { scope: ["markup.italic"], style: { foreground: markdown.emphasis, italic: true } },
      {
        scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"],
        style: { foreground: markdown.code },
      },
      { scope: ["markup.list"], style: { foreground: markdown.listItem } },
      { scope: ["markup.quote"], style: { foreground: markdown.blockQuote, italic: true } },
      {
        scope: ["markup.link", "markup.link.url"],
        style: { foreground: markdown.link, underline: true },
      },
      { scope: ["markup.link.label"], style: { foreground: markdown.linkText, underline: true } },
    ],
    owner,
  );
}

export default Plugin.define({
  id: "capybearista.opencode-auto-advisor.tui",
  setup(context) {
    const client = context.client.rpc(AutoAdvisorRpc) as unknown as Client;
    const [views, setViews] = createSignal<Record<string, View>>({});
    const [reviews, setReviews] = createSignal<Record<string, Latest>>({});
    // Config is global; undefined until the server first answers, so a hidden widget never flashes.
    const [config, setConfig] = createSignal<Pick<Status, "mode" | "sidebar"> | undefined>(
      undefined,
      {
        equals: (a, b) => a?.mode === b?.mode && a?.sidebar === b?.sidebar,
      },
    );
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // The entry id when each consult started: a finished consult is new only if it changed.
    const before = new Map<string, string | undefined>();

    const setView = (sessionID: string, view: View) =>
      setViews((known) => ({ ...known, [sessionID]: view }));
    const apply = (status: Status) => {
      setConfig({ mode: status.mode, sidebar: status.sidebar });
      setReviews((known) => ({ ...known, [status.sessionID]: status.latest }));
    };
    /** Reads the stored review, so one from before a restart shows too. */
    const refresh = (sessionID: string) => {
      client.status({ sessionID }).then(apply, () => {});
    };

    const offStarted = client.events.on("review.started", ({ data }) => {
      if (!data) return;
      apply(data);
      before.set(data.sessionID, data.latest?.id);
      setView(data.sessionID, "reviewing");
    });
    const offFinished = client.events.on("review.finished", ({ data }) => {
      if (!data) return;
      apply(data);
      // A consult that delivered nothing (stale, or no new entry) leaves the latest id unchanged.
      const fresh = Boolean(data.latest) && data.latest?.id !== before.get(data.sessionID);
      before.delete(data.sessionID);
      const view: View = data.failed ? "failed" : fresh ? "finished" : "idle";
      setView(data.sessionID, view);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (views()[data.sessionID] === view) setView(data.sessionID, "idle");
      }, FINISHED_MS);
      timers.add(timer);
    });

    const view = (sessionID: string) => views()[sessionID] ?? "idle";
    const latest = (sessionID: string) => reviews()[sessionID] ?? null;
    const theme = () => context.theme;

    /** Toggles the review panel; outside a session there is no panel to open. */
    const toggle = () => {
      if (context.ui.panel.current()?.name === PANEL) return context.ui.panel.close();
      if (!context.ui.panel.open(PANEL)) {
        context.ui.toast.show({ message: "Open a session to see its Advisor review." });
      }
    };

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "advisor.review",
          title: "Advisor review",
          description: "Show the latest automatic Advisor review",
          group: "Advisor",
          palette: true,
          slash: { name: "advisor-review" },
          run: toggle,
        },
      ],
    }));

    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render(input) {
        const sessionID = () => input.sessionID;
        return node(
          "text",
          {
            fg: () =>
              sessionID() && view(sessionID() as string) === "failed"
                ? theme().text.muted
                : theme().text.base,
          },
          () => {
            const id = sessionID();
            return id ? footerText(view(id), latest(id)) : "";
          },
        );
      },
    });

    // Slot render bodies run once, untracked; the input's fields stay reactive.
    const Widget = (input: { readonly sessionID: string }) => {
      createEffect(on(() => input.sessionID, refresh));
      const shown = createMemo(() => config()?.sidebar === true);
      const color = () => {
        const current = view(input.sessionID);
        if (current === "failed") return theme().text.feedback.error.base;
        if (current === "reviewing") return theme().text.base;
        return latest(input.sessionID) ? theme().text.feedback.success.base : theme().text.muted;
      };
      return () =>
        shown()
          ? untrack(() =>
              node("box", { id: "auto-advisor.sidebar", onMouseUp: toggle }, [
                node("box", { flexDirection: "row", justifyContent: "space-between", gap: 1 }, [
                  node("text", { fg: () => theme().text.base, flexShrink: 0 }, "Advisor"),
                  node("text", { fg: color, wrapMode: "none", truncate: true }, () =>
                    sidebarStatus(
                      view(input.sessionID),
                      latest(input.sessionID),
                      config()?.mode ?? "off",
                    ),
                  ),
                ]),
                () =>
                  latest(input.sessionID)
                    ? node("text", { fg: () => theme().text.muted }, "View review  /advisor-review")
                    : null,
              ]),
            )
          : null;
    };

    const unregisterSidebar = context.ui.slot({
      append: "sidebar.footer",
      render: (input) => Widget(input) as unknown as JSX.Element,
    });

    const Review = (input: PanelInput) => {
      const style = markdownStyle(context.theme, context.renderer.nativeScene);
      createEffect(on(() => input.sessionID, refresh));
      onCleanup(() => {
        void context.renderer
          .idle()
          .catch(() => {})
          .finally(() => style.destroy());
      });
      // Scoped to this panel: the layer goes when the panel closes.
      context.keymap.layer(() => ({
        enabled: () => input.focused,
        commands: [
          {
            id: "advisor.review.close",
            title: "Close Advisor review",
            group: "Advisor",
            bind: "escape,q",
            run: input.close,
          },
          {
            id: "advisor.review.fullscreen",
            title: "Toggle Advisor review full screen",
            group: "Advisor",
            bind: "f",
            run: input.toggleFullscreen,
          },
        ],
      }));
      const review = () => latest(input.sessionID);
      return node(
        "box",
        {
          flexDirection: "column",
          flexGrow: 1,
          minHeight: 0,
          gap: 1,
          paddingTop: 1,
          paddingLeft: 2,
          paddingRight: 2,
        },
        [
          node("box", { flexDirection: "column", flexShrink: 0 }, [
            node("text", { fg: () => theme().text.base }, "Advisor review"),
            node("text", { fg: () => theme().text.muted }, () => panelSummary(review())),
          ]),
          node(
            "scrollbox",
            { flexGrow: 1, minHeight: 0, scrollY: true, contentOptions: { minHeight: 0 } },
            [
              node("markdown", {
                content: () => review()?.advice ?? "",
                fg: () => theme().markdown.text,
                syntaxStyle: style,
                internalBlockMode: "top-level",
              }),
            ],
          ),
          node(
            "text",
            { fg: () => theme().text.muted, flexShrink: 0, onMouseUp: input.close },
            "esc close · f full screen",
          ),
        ],
      );
    };

    const unregisterPanel = context.ui.slot({
      append: "session.panel",
      render: (input) => {
        const open = createMemo(() => input.name === PANEL);
        return (() => (open() ? untrack(() => Review(input)) : null)) as unknown as JSX.Element;
      },
    });

    return () => {
      offStarted();
      offFinished();
      for (const timer of timers) clearTimeout(timer);
      unregisterFooter();
      unregisterSidebar();
      unregisterPanel();
    };
  },
});
