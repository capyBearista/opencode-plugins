import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";

export type SessionID = Parameters<PluginContext["session"]["context"]>[0]["sessionID"];
export type ContextMessage = Awaited<ReturnType<PluginContext["session"]["context"]>>[number];

type AssistantContent = Extract<ContextMessage, { type: "assistant" }>["content"][number];
export type ToolPart = Extract<AssistantContent, { type: "tool" }>;
export type ToolState = ToolPart["state"];
export type ToolStatus = ToolState["status"];
export type ToolContentPart = Extract<ToolState, { status: "completed" }>["content"][number];

export interface ModelReference {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

export interface SerializedError {
  readonly type: string;
  readonly message: string;
}
