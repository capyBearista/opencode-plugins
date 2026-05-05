import "@opentui/solid/preload";
import { describe, expect, test } from "bun:test";
import plugin from "./index.js";

describe("@capybearista/opencode-ram-monitor", () => {
  test("has an id", () => {
    expect(plugin.id).toBeString();
    expect(plugin.id).toBe("capybearista.opencode-ram-monitor");
  });

  test("exports a default object", () => {
    expect(plugin).toBeObject();
  });

  test("exports server hooks", () => {
    expect(plugin.server).toBeFunction();
  });

  test("exports tui hooks", () => {
    expect(plugin.tui).toBeFunction();
  });
});
