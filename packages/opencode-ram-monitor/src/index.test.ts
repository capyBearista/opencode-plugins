import "@opentui/solid/preload";
import { describe, expect, test } from "bun:test";
import serverModule from "./server.js";

describe("@capybearista/opencode-ram-monitor", () => {
  test("has an id", () => {
    expect(serverModule.id).toBeString();
    expect(serverModule.id).toBe("capybearista.opencode-ram-monitor");
  });

  test("exports a default object", () => {
    expect(serverModule).toBeObject();
  });

  test("exports server hooks", () => {
    expect(serverModule.server).toBeFunction();
  });
});
