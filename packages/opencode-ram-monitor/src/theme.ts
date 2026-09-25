import type { ColorInput } from "@opentui/core";

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
  readonly text: ColorInput;
  readonly textMuted: ColorInput;
  readonly secondary: ColorInput;
  readonly error: ColorInput;
  readonly warning: ColorInput;
  readonly success: ColorInput;
  readonly borderSubtle: ColorInput;
  readonly backgroundElement: ColorInput;
}

export function readRamWidgetTheme(tokens: ResolvedRamThemeTokens): RamWidgetTheme {
  return {
    text: tokens.text.base as ColorInput,
    textMuted: tokens.text.muted as ColorInput,
    // V2 exposes no distinct secondary token, so muted doubles as it; the
    // widget has no info state, so feedback.info is intentionally unmapped.
    secondary: tokens.text.muted as ColorInput,
    error: tokens.text.feedback.error.base as ColorInput,
    warning: tokens.text.feedback.warning.base as ColorInput,
    success: tokens.text.feedback.success.base as ColorInput,
    borderSubtle: tokens.border.base as ColorInput,
    backgroundElement: tokens.background.raised.base as ColorInput,
  };
}
