import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { publicImageUrlSchema, inspectionOutputSchema } from "./image-tool-schema";

export const obejrzyjObraz = tool({
  description: "Przekazuje znaleziony obraz do vision, abyś mógł go faktycznie obejrzeć " +
    "i opisać. Użyj po wyszukiwaniu logo lub innej grafiki, zanim potwierdzisz jej wygląd " +
    "albo użyjesz jako referencji. Wymaga znalezionego, bezpośredniego adresu HTTPS " +
    "pliku PNG/JPG/WebP, nie strony HTML ani SVG. Nie zgaduj adresu. " +
    "Po wywołaniu zobacz obraz i opisz go; dopiero wtedy zdecyduj, czy odpowiada poleceniu.",
  inputSchema: z.object({ url: publicImageUrlSchema }),
  outputSchema: inspectionOutputSchema,
  execute: async ({ url }) => {
    const extension = new URL(url).pathname.toLowerCase().split(".").at(-1);
    return { url, mediaType: extension === "png" ? "image/png" as const :
      extension === "webp" ? "image/webp" as const : "image/jpeg" as const };
  },
  // Ten provider obsługuje bezpośrednie URL obrazów z tymi rozszerzeniami.
  // Adres pobiera dostawca vision; serwer aplikacji nie pobiera wskazanych URL.
  toModelOutput: ({ output }) => ({
    type: "content",
    value: [
      { type: "text", text: "Obraz do obejrzenia: " + output.url + ". Opisz to, co widzisz. Sam adres nie potwierdza autentyczności marki." },
      { type: "file", mediaType: output.mediaType, data: { type: "url", url: new URL(output.url) } },
    ],
  }),
});
