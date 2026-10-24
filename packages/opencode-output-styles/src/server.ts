import { Plugin } from "@opencode/plugin";
import { appendReminders, applyStyle, reminderText } from "./prompt.js";
import { OutputStylesRpc, type StyleSummary } from "./rpc.js";
import { DEFAULT_STYLE_ID, discoverStyles, findStyle } from "./styles.js";

const METADATA_KEY = "outputStyle";
const STORAGE_KEY = "default-style";

const isDefault = (style: string) => style.trim().toLowerCase() === DEFAULT_STYLE_ID;
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);

export default Plugin.define({
  id: "capybearista.opencode-output-styles",
  async setup(ctx) {
    const project = ctx.location.project.directory;
    const sidebar = ctx.options.sidebar !== false;

    const sessionStyleOf = (session: { metadata?: unknown }) =>
      asString((session.metadata as Record<string, unknown> | undefined)?.[METADATA_KEY]);

    // Plain JSON-schema definitions type handler inputs as unknown; the host validates them.
    const rpc = await ctx.rpc.register(OutputStylesRpc, {
      async state(input) {
        const { sessionID } = input as { sessionID?: string };
        const styles = [...(await discoverStyles({ project })).values()]
          .sort(
            (a, b) =>
              Number(b.source === "built-in") - Number(a.source === "built-in") ||
              a.name.localeCompare(b.name),
          )
          .map(
            ({ id, name, description, source }): StyleSummary => ({
              id,
              name,
              description,
              source,
            }),
          );

        let sessionStyle: string | null = null;
        if (sessionID) {
          try {
            sessionStyle = sessionStyleOf(await ctx.session.get({ sessionID })) ?? null;
          } catch {}
        }
        return {
          styles,
          defaultStyle: asString(await ctx.storage.get(STORAGE_KEY)) ?? null,
          sessionStyle,
          sidebar,
        };
      },

      async setSessionStyle(input, { error }) {
        const { sessionID, style } = input as { sessionID: string; style: string };
        let stored = DEFAULT_STYLE_ID;
        if (!isDefault(style)) {
          const found = findStyle(await discoverStyles({ project }), style);
          if (!found) return error("unknown_style", `Unknown output style: ${style}`, { style });
          stored = found.id;
        }
        const session = await ctx.session.get({ sessionID });
        const metadata = { ...session.metadata, [METADATA_KEY]: stored };
        await ctx.session.update({ sessionID, metadata });
        return { style: stored };
      },

      async setDefaultStyle(input, { error }) {
        const { style } = input as { style: string };
        if (isDefault(style)) {
          await ctx.storage.remove(STORAGE_KEY);
          return { style: DEFAULT_STYLE_ID };
        }
        const found = findStyle(await discoverStyles({ project }), style);
        if (!found) return error("unknown_style", `Unknown output style: ${style}`, { style });
        await ctx.storage.set(STORAGE_KEY, found.id);
        return { style: found.id };
      },
    });

    const hook = await ctx.session.hook("context", async (event) => {
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        if (session.parentID) return;

        const id = sessionStyleOf(session) ?? asString(await ctx.storage.get(STORAGE_KEY));
        if (!id || isDefault(id)) return;

        const style = findStyle(await discoverStyles({ project }), id);
        if (!style) return;

        let agentHasOwnSystem = true;
        if (!style.keepCodingInstructions) {
          try {
            agentHasOwnSystem = Boolean(
              (await ctx.agent.get({ agentID: event.agent })).data.system,
            );
          } catch {}
        }
        applyStyle(event.system, style, agentHasOwnSystem);
        appendReminders(event.messages, reminderText(style));
      } catch {
        // Styling is best-effort: never fail the user's request.
      }
    });

    return async () => {
      await hook.dispose();
      await rpc.dispose();
    };
  },
});
