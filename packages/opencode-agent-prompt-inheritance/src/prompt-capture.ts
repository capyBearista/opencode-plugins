import { appendFile } from "node:fs/promises";
import type { InheritanceMode } from "./inheritance.js";

type CaptureInput = {
  agentName: string;
  mode: InheritanceMode | null;
  modelID: string;
  inherited: boolean;
  sessionID: string;
  system: string[];
};

export async function captureTransformedSystemPrompt(input: CaptureInput) {
  const captureFile = process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE;
  if (!captureFile) return;

  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionID: input.sessionID,
      agentName: input.agentName,
      modelID: input.modelID,
      mode: input.mode,
      inherited: input.inherited,
      system: input.system,
    });

    await appendFile(captureFile, `${entry}\n`, "utf8");
  } catch (error) {
    // Fail open: debug feature should not break normal chat flow
    console.warn(`[AgentPromptInheritance] Failed to write capture file to ${captureFile}:`, error);
  }
}
