export type InheritanceMode = "prepend" | "append";

export function resolveInheritanceMode(options: Record<string, unknown> | undefined) {
  if (!options) return null;

  const value = Object.hasOwn(options, "inherit-base-prompt")
    ? options["inherit-base-prompt"]
    : options.inheritBasePrompt;

  if (value === "prepend" || value === "append") return value;
  if (value === true) return "prepend";

  return null;
}

export function stitchSystemPrompt(
  basePrompt: string,
  currentPrompt: string,
  mode: InheritanceMode,
) {
  if (!basePrompt) return currentPrompt;
  if (!currentPrompt) return basePrompt;

  return mode === "prepend"
    ? `${basePrompt}\n\n${currentPrompt}`
    : `${currentPrompt}\n\n${basePrompt}`;
}
