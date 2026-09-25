export interface ResolvedRamThemeTokens {
  readonly text: {
    readonly base: unknown;
    readonly muted: unknown;
    readonly feedback: Readonly<
      Record<"error" | "warning" | "success" | "info", { readonly base: unknown }>
    >;
  };
  readonly background: { readonly raised: { readonly base: unknown } };
  readonly border: { readonly base: unknown };
}

export interface RamWidgetTheme {
  readonly text: unknown;
  readonly textMuted: unknown;
  readonly secondary: unknown;
  readonly error: unknown;
  readonly warning: unknown;
  readonly success: unknown;
  readonly borderSubtle: unknown;
  readonly backgroundElement: unknown;
}

export function readRamWidgetTheme(tokens: ResolvedRamThemeTokens): RamWidgetTheme {
  return {
    text: tokens.text.base,
    textMuted: tokens.text.muted,
    // V2 exposes no distinct secondary token, so muted doubles as it; the
    // widget has no info state, so feedback.info is intentionally unmapped.
    secondary: tokens.text.muted,
    error: tokens.text.feedback.error.base,
    warning: tokens.text.feedback.warning.base,
    success: tokens.text.feedback.success.base,
    borderSubtle: tokens.border.base,
    backgroundElement: tokens.background.raised.base,
  };
}
