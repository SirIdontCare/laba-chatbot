import "server-only";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateImage, tool } from "ai";
import { z } from "zod";
import { IMAGE_MESSAGES, isPhotoType } from "./image-input";
import { imageToolInputSchema, imageToolOutputSchema } from "./image-tool-schema";

const modelResponseSchema = z.object({ model: z.string().trim().min(1).optional() });

export const generujObraz = tool({
  description: "Generuje jeden obraz na podstawie opisu użytkownika (prompt do 500 znaków). " +
    "Użyj, gdy użytkownik prosi o stworzenie, narysowanie lub wygenerowanie obrazu. " +
    "Aby użyć rzeczywistego logo lub innego obrazu, przekaż jego wcześniej obejrzany URL " +
    "w referenceImageUrls. Sam opis tekstowy nie dołącza obrazu referencyjnego. " +
    "Obraz jest przekazywany do przeglądarki; po sukcesie dostaniesz tylko potwierdzenie. " +
    "Nie wymyślaj linku do obrazu. Nie wywołuj ponownie po sukcesie, chyba że użytkownik prosi o kilka obrazów.",
  inputSchema: imageToolInputSchema,
  outputSchema: imageToolOutputSchema,
  execute: async ({ prompt, referenceImageUrls }, { abortSignal, messages }) => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return { ok: false as const, komunikat: IMAGE_MESSAGES.configuration };
    if (referenceImageUrls?.length) {
      const inspected = new Set<string>();
      for (const message of messages) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
          if (part.type !== "tool-result" || part.toolName !== "obejrzyjObraz" || part.output.type !== "content") continue;
          for (const item of part.output.value) {
            if (item.type === "file" && item.data.type === "url") inspected.add(String(item.data.url));
          }
        }
      }
      if (referenceImageUrls.some((url) => !inspected.has(url))) return {
        ok: false as const,
        komunikat: "Najpierw obejrzyj obraz referencyjny narzędziem obejrzyjObraz. Nie wygenerowano obrazu z nieobejrzaną referencją.",
      };
    }
    try {
      let actualModelId: string | null = null;
      const openrouter = createOpenRouter({
        apiKey,
        // Provider 3.1.0 podstawia żądany model do response.modelId.
        // Podpis obrazu musi pochodzić z pola model w odpowiedzi API.
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (response.ok) {
            const parsed = modelResponseSchema.safeParse(await response.clone().json());
            actualModelId = parsed.success ? parsed.data.model ?? null : null;
          }
          return response;
        },
      });
      const timeout = AbortSignal.timeout(110_000);
      const { image } = await generateImage({
        model: openrouter.imageModel("google/gemini-nano-banana-2.1"),
        prompt: referenceImageUrls?.length ? { text: prompt, images: referenceImageUrls } : prompt,
        maxRetries: 0,
        abortSignal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout,
      });
      if (!isPhotoType(image.mediaType)) throw new Error("Unsupported image format");
      return {
        ok: true as const, url: `data:${image.mediaType};base64,${image.base64}`,
        mediaType: image.mediaType as "image/png" | "image/jpeg" | "image/webp", modelId: actualModelId,
      };
    } catch {
      return { ok: false as const, komunikat: IMAGE_MESSAGES.unavailable };
    }
  },
  // Dotyczy zarówno kolejnego kroku streamText, jak i historii następnych tur.
  // Pełny wynik narzędzia nadal trafia do UI przez toUIMessageStream.
  toModelOutput: ({ output }) => ({
    type: "text", value: output.ok ? "obraz wygenerowany" : output.komunikat,
  }),
});
