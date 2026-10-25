import { Plugin } from "@opencode/plugin";
import { appendReminders, applyStyle, reminderText } from "./prompt.js";
import { DEFAULT_STYLE_ID, METADATA_KEY, OutputStylesRpc, type StyleSummary } from "./rpc.js";
import { discoverStyles, findStyle } from "./styles.js";

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
        const discovered = await discoverStyles({ project });
        const styles = [...discovered.values()]
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
        let subagent = false;
        if (sessionID) {
          try {
            const session = await ctx.session.get({ sessionID });
            sessionStyle = sessionStyleOf(session) ?? null;
            subagent = Boolean(session.parentID);
          } catch {}
        }
        const storedDefault = asString(await ctx.storage.get(STORAGE_KEY));
        const defaultStyle = storedDefault ? findStyle(discovered, storedDefault) : undefined;
        return {
          styles,
          defaultStyle: defaultStyle?.id ?? null,
          sessionStyle,
          sidebar,
          subagent,
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
        if (session.parentID) {
          return error("subagent_session", "Subagent sessions don't use output styles", {
            sessionID,
          });
        }
        const metadata = { ...session.metadata, [METADATA_KEY]: stored };
        await ctx.session.update({ sessionID, metadata });
        return { style: stored };
      },

      async clearSessionStyle(input, { error }) {
        const { sessionID } = input as { sessionID: string };
        const session = await ctx.session.get({ sessionID });
        if (session.parentID) {
          return error("subagent_session", "Subagent sessions don't use output styles", {
            sessionID,
          });
        }
        const metadata = { ...session.metadata };
        delete metadata[METADATA_KEY];
        await ctx.session.update({ sessionID, metadata });
        return { sessionID };
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
        const [session, storedDefault, context] = await Promise.all([
          ctx.session.get({ sessionID: event.sessionID }),
          ctx.storage.get(STORAGE_KEY),
          ctx.session.context({ sessionID: event.sessionID }).catch(() => []),
        ]);
        if (session.parentID) return;

        const id = sessionStyleOf(session) ?? asString(storedDefault);
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
        const prompts = new Set(context.filter((m) => m.type === "user").map((m) => m.id));
        appendReminders(
          event.messages,
          reminderText(style),
          (m) => m.id !== undefined && prompts.has(m.id),
        );
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
