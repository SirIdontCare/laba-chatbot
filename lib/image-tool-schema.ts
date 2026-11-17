import { z } from "zod";

export const publicImageUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (!url.port || url.port === "443") &&
      /\.[a-z]{2,}$/i.test(url.hostname) &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/i.test(url.hostname) &&
      /\.(png|jpe?g|webp)(?:[?#].*)?$/i.test(value);
  } catch {
    return false;
  }
}, "Podaj publiczny, bezpośredni adres HTTPS obrazu PNG/JPG/WebP.");

export const inspectionOutputSchema = z.object({
  url: publicImageUrlSchema,
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
});

export const imageToolInputSchema = z.object({
  prompt: z.string().trim().min(1).max(500),
  referenceImageUrls: z.array(publicImageUrlSchema).max(2).optional()
    .describe("Adresy obrazów wcześniej przekazanych do obejrzyjObraz. Użyj do zachowania logo lub innej referencji w generowanym obrazie."),
});
export const imageToolOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true), url: z.string().regex(/^data:image\/(png|jpeg|webp);base64,/),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    modelId: z.string().nullable(),
  }),
  z.object({ ok: z.literal(false), komunikat: z.string() }),
]);
