import { Plugin } from "@opencode/plugin";
import {
  appendReminders,
  ENTRY_KEY,
  entryValue,
  REMINDER_METADATA_KEY,
  reminderText,
} from "./prompt.js";
import { DEFAULT_STYLE_ID, METADATA_KEY, OutputStylesRpc, type StyleSummary } from "./rpc.js";
import { discoverStyles, findStyle, type Style } from "./styles.js";

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

    // The style travels as an instruction entry, never in the system prompt, so switching styles
    // appends an update instead of invalidating the cached request prefix.
    const syncEntry = async (sessionID: string, style: Style | undefined) => {
      const entries = await ctx.session.instructions.entry.list({ sessionID });
      const current = entries.find((entry) => entry.key === ENTRY_KEY);
      if (!style) {
        if (current) await ctx.session.instructions.entry.remove({ sessionID, key: ENTRY_KEY });
        return;
      }
      const value = entryValue(style);
      if (current?.value !== value) {
        await ctx.session.instructions.entry.put({ sessionID, key: ENTRY_KEY, value });
      }
    };

    // Prompts are admitted before the step that reads entries, so a change applies to this turn.
    const promptHook = await ctx.session.hook("prompt", async (event) => {
      try {
        const [session, storedDefault] = await Promise.all([
          ctx.session.get({ sessionID: event.sessionID }),
          ctx.storage.get(STORAGE_KEY),
        ]);
        if (session.parentID) return;

        const id = sessionStyleOf(session) ?? asString(storedDefault);
        const style =
          id && !isDefault(id) ? findStyle(await discoverStyles({ project }), id) : undefined;
        await syncEntry(event.sessionID, style);
        if (style) {
          event.metadata = { ...event.metadata, [REMINDER_METADATA_KEY]: reminderText(style) };
        }
      } catch {
        // Styling is best-effort: never fail the user's prompt.
      }
    });

    const contextHook = await ctx.session.hook("context", async (event) => {
      try {
        const context = await ctx.session.context({ sessionID: event.sessionID });
        const reminders = new Map<string, string>();
        for (const message of context) {
          const text =
            message.type === "user" && asString(message.metadata?.[REMINDER_METADATA_KEY]);
          if (text) reminders.set(message.id, text);
        }
        appendReminders(event.messages, (messageID) => reminders.get(messageID));
      } catch {
        // Styling is best-effort: never fail the user's request.
      }
    });

    return async () => {
      await promptHook.dispose();
      await contextHook.dispose();
      await rpc.dispose();
    };
  },
});
