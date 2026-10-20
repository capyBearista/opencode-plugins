import { describe, expect, test } from "bun:test";
import {
  resolveZenAuth,
  resolveZenToken,
  ZEN_INTEGRATION_ID,
  ZEN_PUBLIC_TOKEN,
  type ZenConnectionDomain,
} from "./zen-auth.js";

const connectionInfo = { type: "credential", id: "cred-1" } as never;

function integration(
  active: ZenConnectionDomain["active"],
  resolve: ZenConnectionDomain["resolve"],
): ZenConnectionDomain {
  return { active, resolve };
}

const activeWith = (credential: unknown) =>
  integration(
    async () => connectionInfo,
    async () => credential as never,
  );

describe("zen auth resolution", () => {
  test("uses the plugin integration connection for the opencode zen credential", async () => {
    const seen: string[] = [];
    const domain = integration(
      async (id) => {
        seen.push(id);
        return connectionInfo;
      },
      async () => ({ type: "key", key: "secret-key" }) as never,
    );

    expect(await resolveZenToken(domain)).toBe("secret-key");
    expect(seen).toEqual([ZEN_INTEGRATION_ID]);
  });

  test("uses the oauth access token when the credential is oauth", async () => {
    const domain = activeWith({ type: "oauth", access: "oauth-access", refresh: "r", expires: 1 });
    expect(await resolveZenToken(domain)).toBe("oauth-access");
  });

  test("falls back to the public token without a plugin-safe credential", async () => {
    expect(await resolveZenToken(undefined)).toBe(ZEN_PUBLIC_TOKEN);
    expect(
      await resolveZenToken(
        integration(
          async () => undefined,
          async () => undefined,
        ),
      ),
    ).toBe(ZEN_PUBLIC_TOKEN);
    expect(
      await resolveZenToken(
        integration(
          async () => connectionInfo,
          async () => undefined,
        ),
      ),
    ).toBe(ZEN_PUBLIC_TOKEN);
    expect(await resolveZenToken(activeWith({ type: "key", key: "  " }))).toBe(ZEN_PUBLIC_TOKEN);
  });

  test("surfaces connection lookup failures so the caller can fail open", async () => {
    const domain = integration(
      async () => {
        throw new Error("integration store unavailable");
      },
      async () => undefined,
    );
    await expect(resolveZenToken(domain)).rejects.toThrow("integration store unavailable");
  });

  test("returns a bearer auth definition", async () => {
    const auth = await resolveZenAuth(undefined);
    expect(typeof auth.apply).toBe("function");
  });
});
