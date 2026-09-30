import { Auth } from "@opencode/ai";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";

export const ZEN_INTEGRATION_ID = "opencode";
export const ZEN_PUBLIC_TOKEN = "public";

export type ZenConnectionDomain = PluginContext["integration"]["connection"];

export async function resolveZenAuth(
  integration: ZenConnectionDomain | undefined,
): Promise<Auth.Definition> {
  return Auth.bearer(await resolveZenToken(integration));
}

export async function resolveZenToken(
  integration: ZenConnectionDomain | undefined,
): Promise<string> {
  if (!integration) return ZEN_PUBLIC_TOKEN;
  const connection = await integration.active(ZEN_INTEGRATION_ID);
  if (!connection) return ZEN_PUBLIC_TOKEN;
  const credential = await integration.resolve(connection);
  if (!credential) return ZEN_PUBLIC_TOKEN;
  const token = credential.type === "oauth" ? credential.access : credential.key;
  return token.trim() === "" ? ZEN_PUBLIC_TOKEN : token;
}
