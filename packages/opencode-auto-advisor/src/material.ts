import type { AssistantBlock } from "./serialize-assistant.js";

export const ADVISOR_TOOL_NAME = "advisor";

export function isAdvisorOriginBlock(block: AssistantBlock): boolean {
  if (block.type === "tool-call" || block.type === "tool-result" || block.type === "tool-error") {
    return block.name === ADVISOR_TOOL_NAME;
  }
  return false;
}

export function materialBlocks(blocks: readonly AssistantBlock[]): AssistantBlock[] {
  return blocks.filter((block) => !isAdvisorOriginBlock(block));
}
