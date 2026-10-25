import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createSignal } from "solid-js";
import { OutputStylesRpc, type StateOutput } from "./rpc.js";

const PICK_COMMAND = "output-styles.pick";
const DEFAULT_STYLE = "default";

interface Info {
  readonly styles: StateOutput["styles"];
  readonly defaultStyle: string | null;
  readonly sidebar: boolean;
}

// The JSON-schema RPC definition carries no static output types.
interface Client {
  state(input: { sessionID?: string }): Promise<StateOutput>;
  setSessionStyle(input: { sessionID: string; style: string }): Promise<{ style: string }>;
  setDefaultStyle(input: { style: string }): Promise<{ style: string }>;
}

function errorType(error: unknown): string | undefined {
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : undefined;
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

function storedStyle(metadata: unknown): string | null {
  const style = (metadata as { outputStyle?: unknown } | null | undefined)?.outputStyle;
  return typeof style === "string" ? style : null;
}

export default Plugin.define({
  id: "capybearista.opencode-output-styles.tui",
  setup(context) {
    const rpc = context.client.rpc(OutputStylesRpc) as unknown as Client;
    const toast = context.ui.toast;
    const [info, setInfo] = createSignal<Info>({ styles: [], defaultStyle: null, sidebar: false });
    // Per-session style from events and our own writes; null means "no stored style".
    const [live, setLive] = createSignal<Record<string, string | null>>({});

    const nameOf = (id: string) =>
      id === DEFAULT_STYLE ? "Default" : (info().styles.find((s) => s.id === id)?.name ?? id);

    const effective = (sessionID: string) => {
      const known = live();
      const own =
        sessionID in known
          ? known[sessionID]
          : storedStyle(context.data.session.get(sessionID)?.metadata);
      return own ?? info().defaultStyle ?? DEFAULT_STYLE;
    };

    const remember = (state: StateOutput) =>
      setInfo({ styles: state.styles, defaultStyle: state.defaultStyle, sidebar: state.sidebar });

    const report = (error: unknown, style: string) => {
      if (errorType(error) === "unknown_style") {
        toast.show({ message: `Unknown output style "${style}"`, variant: "warning" });
      } else {
        toast.show({ message: errorMessage(error), variant: "error" });
      }
    };

    const setSession = async (sessionID: string, style: string) => {
      try {
        const result = await rpc.setSessionStyle({ sessionID, style });
        setLive((known) => ({ ...known, [sessionID]: result.style }));
        toast.show({ message: `Output style: ${nameOf(result.style)}`, variant: "success" });
      } catch (error) {
        report(error, style);
      }
    };

    const setDefault = async (style: string, forNewSessions: boolean) => {
      try {
        const result = await rpc.setDefaultStyle({ style });
        const defaultStyle = result.style === DEFAULT_STYLE ? null : result.style;
        setInfo((current) => ({ ...current, defaultStyle }));
        const suffix = forNewSessions ? " (default for new sessions)" : "";
        toast.show({
          message: `Output style: ${nameOf(result.style)}${suffix}`,
          variant: "success",
        });
        return true;
      } catch (error) {
        report(error, style);
        return false;
      }
    };

    const apply = async (sessionID: string | undefined, style: string) => {
      if (sessionID) await setSession(sessionID, style);
      else await setDefault(style, true);
    };

    const pick = async (sessionID: string | undefined) => {
      let state: StateOutput;
      try {
        state = await rpc.state(sessionID ? { sessionID } : {});
      } catch (error) {
        toast.show({ message: errorMessage(error), variant: "error" });
        return;
      }
      remember(state);
      const current =
        (sessionID ? state.sessionStyle : null) ?? state.defaultStyle ?? DEFAULT_STYLE;
      const picked = await context.ui.dialog.select<string>({
        title: "Output style",
        current,
        options: [
          { title: "Default", value: DEFAULT_STYLE, description: "No output style" },
          ...state.styles.map((style) => ({
            title: style.name,
            value: style.id,
            description: style.description,
            footer: style.id === state.defaultStyle ? `${style.source} (default)` : style.source,
          })),
        ],
        actions: [
          {
            bind: "ctrl+d",
            title: "Set as default",
            // The open dialog keeps its labels, so reopen it to move the "(default)" marker.
            onTrigger: async (value) => {
              if (!(await setDefault(value, false))) return;
              context.ui.dialog.clear();
              await pick(sessionID);
            },
          },
        ],
      });
      if (picked !== undefined) await apply(sessionID, picked);
    };

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: PICK_COMMAND,
          title: "Output style",
          group: "Output style",
          palette: true,
          slash: { name: "output-style", arguments: true },
          run(input) {
            const arg = input?.trim();
            const route = context.ui.router.current();
            const sessionID = route.type === "session" ? route.sessionID : undefined;
            return arg ? apply(sessionID, arg) : pick(sessionID);
          },
        },
      ],
    }));

    const off = context.data.on("session.metadata.updated", (event) => {
      const style = storedStyle(event.data.metadata);
      setLive((known) => ({ ...known, [event.data.sessionID]: style }));
    });

    // The slot must exist at setup; it renders nothing until the server enables the sidebar.
    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render(input) {
        const line = createElement("text");
        spread(
          line,
          {
            get fg() {
              return context.theme.text.base;
            },
            wrapMode: "none",
            truncate: true,
          },
          true,
        );
        insert(line, () => `Style: ${nameOf(effective(input.sessionID))}`);

        const box = createElement("box");
        spread(box, { onMouseUp: () => context.keymap.dispatch(PICK_COMMAND) }, true);
        insert(box, () => (info().sidebar ? line : null));
        return box as unknown as JSX.Element;
      },
    });

    rpc.state({}).then(remember, () => {
      toast.show({ message: "Output styles: server plugin not reachable", variant: "error" });
    });

    return () => {
      off();
      unregisterSlot();
    };
  },
});
