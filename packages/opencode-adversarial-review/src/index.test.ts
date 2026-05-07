import { describe, expect, test } from "bun:test";
import plugin from "./index";

describe("@capybearista/opencode-adversarial-review", () => {
  test("has an id", () => {
    expect(plugin.id).toBeString();
    expect(plugin.id).toBe("capybearista.opencode-adversarial-review");
  });

  test("exports a default object", () => {
    expect(plugin).toBeObject();
  });

  test("exports server hooks", () => {
    expect(plugin.server).toBeFunction();
  });
});
