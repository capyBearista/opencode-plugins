import { describe, expect, test } from "bun:test";
import plugin from "./index.js";

describe("@capybearista/opencode-agents-loader", () => {
  test("has an id", () => {
    expect(plugin.id).toBe("capybearista.opencode-agents-loader");
  });

  test("exports server hooks", () => {
    expect(plugin.server).toBeFunction();
  });
});
