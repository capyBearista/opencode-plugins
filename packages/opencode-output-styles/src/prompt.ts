import type { Style } from "./styles.js";

export const FALLBACK_REMINDER = "Remember to follow the specific guidelines for this style.";

const CODING_HEADINGS = new Set(["# Working in codebases", "# Code comments"]);

export interface TextPart {
  type: "text";
  text: string;
}

export function reminderText(style: Pick<Style, "name" | "turnReminder">): string {
  return `<system-reminder>\n${style.name} output style is active. ${style.turnReminder ?? FALLBACK_REMINDER}\n</system-reminder>`;
}

export function stripCodingSections(text: string): string {
  const kept: string[] = [];
  let skipping = false;
  let removed = false;
  for (const line of text.split("\n")) {
    if (CODING_HEADINGS.has(line.trimEnd())) {
      skipping = true;
      removed = true;
    } else if (line.startsWith("# ")) {
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  if (!removed) return text;
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function applyStyle(
  system: Array<{ type: string; text: string }>,
  style: Style,
  agentHasOwnSystem: boolean,
): void {
  const base = system[0];
  if (!style.keepCodingInstructions && !agentHasOwnSystem && base) {
    system[0] = { ...base, text: stripCodingSections(base.text) };
  }
  system.push({ type: "text", text: style.prompt });
}

// Only real prompts get the reminder: OpenCode also sends harness text (synthetic, skill, shell,
// compaction) as role "user", so the caller says which messages are prompts.
export function appendReminders(
  messages: Array<{ role: string; id?: string; content: unknown }>,
  text: string,
  isPrompt: (message: { role: string; id?: string; content: unknown }) => boolean,
): number {
  let modified = 0;
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content) || !isPrompt(message)) continue;
    const parts: Array<{ type?: unknown; text?: unknown }> = message.content;
    if (parts.some((part) => part.type === "text" && part.text === text)) continue;
    parts.push({ type: "text", text });
    modified++;
  }
  return modified;
}
