import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createSignal } from "solid-js";
import { DEFAULT_STYLE_ID, METADATA_KEY, OutputStylesRpc, type StateOutput } from "./rpc.js";

const PICK_COMMAND = "output-styles.pick";
// Style ids are filenames, which can't contain "/", so this never collides with one.
const GLOBAL = "/global";
const SUBAGENT_MESSAGE = "Subagent sessions don't use output styles";

interface Info {
  readonly styles: StateOutput["styles"];
  readonly defaultStyle: string | null;
  readonly sidebar: boolean;
}

// The JSON-schema RPC definition carries no static output types.
interface Client<Options = undefined> {
  state(input: { sessionID?: string }, options?: Options): Promise<StateOutput>;
  setSessionStyle(
    input: { sessionID: string; style: string },
    options?: Options,
  ): Promise<{ style: string }>;
  clearSessionStyle(
    input: { sessionID: string },
    options?: Options,
  ): Promise<{ sessionID: string }>;
  setDefaultStyle(input: { style: string }, options?: Options): Promise<{ style: string }>;
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
  const style = (metadata as Record<string, unknown> | null | undefined)?.[METADATA_KEY];
  return typeof style === "string" ? style : null;
}

export default Plugin.define({
  id: "capybearista.opencode-output-styles.tui",
  setup(context) {
    const client = context.client.rpc(OutputStylesRpc) as unknown as Client<{
      location: typeof context.location;
    }>;
    // A shared server runs one plugin instance per project. Without a location, calls reach
    // the server's default project, so route each one to the session's project (the one its
    // requests are styled in), else this TUI's.
    const at = (sessionID?: string) => ({
      location:
        (sessionID ? context.data.session.get(sessionID)?.location : undefined) ??
        context.location ??
        context.data.location.default(),
    });
    const rpc: Client = {
      state: (input) => client.state(input, at(input.sessionID)),
      setSessionStyle: (input) => client.setSessionStyle(input, at(input.sessionID)),
      clearSessionStyle: (input) => client.clearSessionStyle(input, at(input.sessionID)),
      setDefaultStyle: (input) => client.setDefaultStyle(input, at()),
    };
    const toast = context.ui.toast;
    const [info, setInfo] = createSignal<Info>({ styles: [], defaultStyle: null, sidebar: false });
    // Per-session style from events and our own writes; null means "no stored style".
    const [live, setLive] = createSignal<Record<string, string | null>>({});

    const isChild = (sessionID: string) => Boolean(context.data.session.get(sessionID)?.parentID);

    const nameOf = (id: string) =>
      id === DEFAULT_STYLE_ID ? "None" : (info().styles.find((s) => s.id === id)?.name ?? id);

    const effective = (sessionID: string) => {
      const known = live();
      const own =
        sessionID in known
          ? known[sessionID]
          : storedStyle(context.data.session.get(sessionID)?.metadata);
      const id = own ?? info().defaultStyle ?? DEFAULT_STYLE_ID;
      // The server applies no style for an id that doesn't resolve.
      return id === DEFAULT_STYLE_ID || info().styles.some((s) => s.id === id)
        ? id
        : DEFAULT_STYLE_ID;
    };

    const remember = (state: StateOutput) =>
      setInfo({ styles: state.styles, defaultStyle: state.defaultStyle, sidebar: state.sidebar });

    const report = (error: unknown, style: string) => {
      if (errorType(error) === "unknown_style") {
        toast.show({ message: `Unknown output style "${style}"`, variant: "warning" });
      } else if (errorType(error) === "subagent_session") {
        toast.show({ message: SUBAGENT_MESSAGE, variant: "warning" });
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

    const useGlobal = async (sessionID: string) => {
      try {
        await rpc.clearSessionStyle({ sessionID });
        setLive((known) => ({ ...known, [sessionID]: null }));
        const name = nameOf(info().defaultStyle ?? DEFAULT_STYLE_ID);
        toast.show({ message: `Output style: uses global (${name})`, variant: "success" });
      } catch (error) {
        report(error, GLOBAL);
      }
    };

    const setGlobal = async (style: string) => {
      try {
        const result = await rpc.setDefaultStyle({ style });
        const defaultStyle = result.style === DEFAULT_STYLE_ID ? null : result.style;
        setInfo((current) => ({ ...current, defaultStyle }));
        toast.show({
          message: `Global output style: ${nameOf(result.style)}`,
          variant: "success",
        });
      } catch (error) {
        report(error, style);
      }
    };

    // In a session the picker and command edit that session; on the home screen, the global setting.
    const apply = async (sessionID: string | undefined, style: string) => {
      if (style === GLOBAL) {
        if (sessionID) await useGlobal(sessionID);
        else
          toast.show({
            message: "Open a session to use the global output style",
            variant: "warning",
          });
      } else if (sessionID) await setSession(sessionID, style);
      else await setGlobal(style);
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
      // The TUI's session cache may not hold subagent sessions, so ask the server.
      if (state.subagent) {
        toast.show({ message: SUBAGENT_MESSAGE, variant: "warning" });
        return;
      }
      const current = sessionID
        ? (state.sessionStyle ?? GLOBAL)
        : (state.defaultStyle ?? DEFAULT_STYLE_ID);
      const picked = await context.ui.dialog.select<string>({
        title: sessionID ? "Output style · this session" : "Output style · global",
        current,
        options: [
          { title: "None", value: DEFAULT_STYLE_ID, description: "No output style" },
          ...(sessionID
            ? [
                {
                  title: `Use global (${nameOf(state.defaultStyle ?? DEFAULT_STYLE_ID)})`,
                  value: GLOBAL,
                  description: "Follow the global setting",
                },
              ]
            : []),
          ...state.styles.map((style) => ({
            title: style.name,
            value: style.id,
            description: style.description,
            footer:
              style.id === state.defaultStyle ? `${style.source} · global setting` : style.source,
          })),
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
            if (sessionID && isChild(sessionID)) {
              toast.show({ message: SUBAGENT_MESSAGE, variant: "warning" });
              return;
            }
            if (!arg) return pick(sessionID);
            const word = arg.toLowerCase();
            return apply(
              sessionID,
              word === "global" ? GLOBAL : word === "none" ? DEFAULT_STYLE_ID : arg,
            );
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
        insert(line, () => `Output Style: ${nameOf(effective(input.sessionID))}`);

        const box = createElement("box");
        spread(box, { onMouseUp: () => context.keymap.dispatch(PICK_COMMAND) }, true);
        insert(box, () => (info().sidebar && !isChild(input.sessionID) ? line : null));
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
