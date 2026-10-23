import { describe, expect, test } from "bun:test";
import { readRamWidgetTheme } from "./theme.js";

describe("readRamWidgetTheme", () => {
  test("maps V2 theme tokens onto widget theme keys", () => {
    const theme = readRamWidgetTheme({
      text: {
        base: "white",
        muted: "gray",
        feedback: {
          error: { base: "red" },
          warning: { base: "yellow" },
          success: { base: "green" },
          info: { base: "blue" },
        },
      },
      background: { raised: { base: "#111111" } },
      border: { base: "dimgray" },
    });

    expect(theme).toEqual({
      text: "white",
      textMuted: "gray",
      secondary: "gray",
      error: "red",
      warning: "yellow",
      success: "green",
      borderSubtle: "dimgray",
      backgroundElement: "#111111",
    });
  });
});
