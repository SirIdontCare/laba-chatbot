import { z } from "zod";

// strictObject odrzuca dodatkowe pola; nie uzupełniamy braków ani nie konwertujemy typów.
export const analysisSchema = z.strictObject({
  category: z.enum(["sales", "support", "billing", "unknown"]),
  priority: z.enum(["normal", "high"]),
  draft: z.string(),
  needs_review: z.boolean(),
});

export type Analysis = z.infer<typeof analysisSchema>;

export const analysisRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(12_000),
});
