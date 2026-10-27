import type { Style } from "./styles.js";

export const FALLBACK_REMINDER = "Remember to follow the specific guidelines for this style.";

export const ENTRY_KEY = "output-style";
export const REMINDER_METADATA_KEY = "outputStyleReminder";

export function entryValue(style: Pick<Style, "name" | "prompt">): string {
  return `${style.name} output style\n\n${style.prompt}`;
}

export function reminderText(style: Pick<Style, "name" | "turnReminder">): string {
  return `<system-reminder>\n${style.name} output style is active. ${style.turnReminder ?? FALLBACK_REMINDER}\n</system-reminder>`;
}

// Each prompt keeps the reminder recorded when it was sent, so an earlier turn never changes
// and the cached prefix survives a style switch.
export function appendReminders(
  messages: Array<{ role: string; id?: string; content: unknown }>,
  reminderOf: (id: string) => string | undefined,
): number {
  let modified = 0;
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content) || !message.id) continue;
    const text = reminderOf(message.id);
    if (!text) continue;
    const parts: Array<{ type?: unknown; text?: unknown }> = message.content;
    if (parts.some((part) => part.type === "text" && part.text === text)) continue;
    parts.push({ type: "text", text });
    modified++;
  }
  return modified;
}
