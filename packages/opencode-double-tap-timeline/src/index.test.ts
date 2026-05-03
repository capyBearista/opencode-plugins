import { describe, expect, test } from "bun:test";
import plugin from "./index.js";

describe("@capybearista/opencode-double-tap-timeline", () => {
  test("has an id", () => {
    expect(plugin.id).toBe("capybearista.opencode-double-tap-timeline");
  });

  test("exports tui hooks", () => {
    expect(plugin.tui).toBeFunction();
  });
});
