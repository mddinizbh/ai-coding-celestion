import type { PromptInput } from './history-observer-shapes';

export function computePromptMetrics(prompt: PromptInput): { readonly partCount: number; readonly serializedBytes: number } {
  const textPart = 1;
  const filesPart = prompt.files?.length ?? 0;
  const agentsPart = prompt.agents?.length ?? 0;
  const skillsPart = prompt.skills?.length ?? 0;
  const partCount = textPart + filesPart + agentsPart + skillsPart;
  const serializedBytes = new TextEncoder().encode(JSON.stringify(prompt)).byteLength;
  return { partCount, serializedBytes };
}
