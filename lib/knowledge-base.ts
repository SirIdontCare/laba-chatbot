import "server-only";
import { z } from "zod";
import { splitIntoChunks } from "./chunking";
import { getSupabase } from "./supabase";

export const MAX_TITLE_CHARS = 200;
export const MAX_CONTENT_CHARS = 20_000;

export const uploadSchema = z.strictObject({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
});

// Zapisuje dokument i jego fragmenty (bez embeddingów). Gdy zapis fragmentów się nie uda,
// usuwa niedokończony dokument, żeby w bazie nie zostały połówki.
export async function saveDocument(input: z.infer<typeof uploadSchema>) {
  const chunks = splitIntoChunks(input.content);
  if (!chunks.length) throw new Error("Brak fragmentów.");
  const supabase = getSupabase();

  const { data: document, error } = await supabase
    .from("documents").insert({ title: input.title }).select("id").single();
  if (error || !document) throw new Error("Nie udało się zapisać dokumentu.");

  const { error: chunksError } = await supabase.from("chunks").insert(
    chunks.map((content, chunk_index) => ({ document_id: document.id, chunk_index, content })),
  );
  if (chunksError) {
    await supabase.from("chunks").delete().eq("document_id", document.id);
    await supabase.from("documents").delete().eq("id", document.id);
    throw new Error("Nie udało się zapisać fragmentów.");
  }
  return { id: document.id as number, title: input.title, chunks: chunks.length };
}
