import { describe, expect, test } from "bun:test";
import plugin from "./index.js";

describe("@capybearista/opencode-output-styles", () => {
  test("has an id", () => {
    expect(plugin.id).toBeString();
    expect(plugin.id).toBe("capybearista.opencode-output-styles");
  });

  test("exports a default object", () => {
    expect(plugin).toBeObject();
  });

  test("exports server hooks", () => {
    expect(plugin.server).toBeFunction();
  });
});
