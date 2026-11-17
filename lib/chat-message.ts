import type { UIMessage } from "ai";
import { z } from "zod";

export const chatMessageMetadataSchema = z.object({
  retrievedAt: z.iso.datetime().optional(),
  modelId: z.string().nullable().optional(),
  vision: z.boolean().optional(),
  kind: z.literal("image-generation").optional(),
  steps: z.array(z.object({ number: z.number().int().positive(), tool: z.string() })).optional(),
  stats: z.object({ steps: z.number(), toolCalls: z.number(), elapsedMs: z.number() }).optional(),
  stoppedReason: z.string().optional(),
  limitReached: z.boolean().optional(),
  partialResults: z.array(z.object({ tool: z.string(), text: z.string() })).optional(),
});

export type ChatMessage = UIMessage<z.infer<typeof chatMessageMetadataSchema>>;

export function conversationForModel(messages: ChatMessage[]) {
  return messages.filter((message) => message.metadata?.kind !== "image-generation");
}

export function markInterrupted(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  const notice = { type: "text" as const, text: "\n\nPrzerwane przez użytkownika" };
  if (last?.role === "assistant") {
    return [...messages.slice(0, -1), { ...last, parts: [...last.parts, notice] }];
  }
  return [...messages, { id: crypto.randomUUID(), role: "assistant", parts: [notice] }];
}
