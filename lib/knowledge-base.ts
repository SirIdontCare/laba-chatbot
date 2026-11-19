import "server-only";
import { embedMany } from "ai";
import { z } from "zod";
import { splitIntoChunks } from "./chunking";
import { EMBEDDING_DIMENSIONS, embeddingModel } from "./model";
import { getSupabase } from "./supabase";

export const MAX_TITLE_CHARS = 200;
export const MAX_CONTENT_CHARS = 20_000;
// Ile starszych fragmentów bez embeddingu uzupełniamy przy jednym imporcie (reszta przy kolejnym).
export const BACKFILL_LIMIT = 200;

export const uploadSchema = z.strictObject({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
});

// Błąd z komunikatem po polsku, który można pokazać użytkownikowi.
export class KnowledgeBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBaseError";
  }
}

export const KB_MESSAGES = {
  config: "Na serwerze brakuje konfiguracji modelu embeddingów (OPENROUTER_EMBEDDING_MODEL). Dokument nie został zapisany.",
  document: "Nie udało się zapisać dokumentu w bazie wiedzy. Nic nie zostało zapisane. Spróbuj ponownie za chwilę.",
  embeddings: "Nie udało się przygotować dokumentu do wyszukiwania (błąd tworzenia embeddingów). Dokument nie został zapisany. Spróbuj ponownie za chwilę.",
  chunks: "Nie udało się zapisać fragmentów dokumentu. Dokument nie został zapisany. Spróbuj ponownie za chwilę.",
  cleanup: "Nie udało się zapisać dokumentu, a jego niedokończona wersja mogła zostać w bazie wiedzy. Spróbuj ponownie za chwilę.",
} as const;

type StoredChunk = { id: number; content: string };

// Zapisuje dokument, jego fragmenty i embeddingi fragmentów. Jednym wywołaniem embedMany
// tworzy wektory dla nowych fragmentów i dla starszych fragmentów z pustą kolumną embedding.
// Gdy embeddingi albo zapis fragmentów się nie udadzą, usuwa niedokończony dokument.
export async function saveDocument(input: z.infer<typeof uploadSchema>) {
  const chunks = splitIntoChunks(input.content);
  if (!chunks.length) throw new KnowledgeBaseError(KB_MESSAGES.document);
  let model;
  try { model = embeddingModel(); } catch { throw new KnowledgeBaseError(KB_MESSAGES.config); }
  const supabase = getSupabase();

  // Starsze fragmenty bez embeddingu; błąd odczytu nie blokuje importu nowego dokumentu.
  const { data: pending } = await supabase.from("chunks").select("id, content")
    .is("embedding", null).order("id").limit(BACKFILL_LIMIT);
  const stale: StoredChunk[] = Array.isArray(pending) ? pending : [];

  const { data: document, error } = await supabase
    .from("documents").insert({ title: input.title }).select("id").single();
  if (error || !document) throw new KnowledgeBaseError(KB_MESSAGES.document);
  const documentId = document.id as number;

  const discard = async (message: string): Promise<never> => {
    const { error: chunksDeleteError } = await supabase.from("chunks").delete().eq("document_id", documentId);
    const { error: documentDeleteError } = await supabase.from("documents").delete().eq("id", documentId);
    throw new KnowledgeBaseError(chunksDeleteError || documentDeleteError ? KB_MESSAGES.cleanup : message);
  };

  let embeddings: number[][];
  try {
    ({ embeddings } = await embedMany({ model, values: [...chunks, ...stale.map(chunk => chunk.content)] }));
  } catch {
    return discard(KB_MESSAGES.embeddings);
  }
  if (embeddings.length !== chunks.length + stale.length || !embeddings.every(validEmbedding)) {
    return discard(KB_MESSAGES.embeddings);
  }

  // Nowe fragmenty trafiają do bazy od razu z embeddingami: jeden insert, wszystko albo nic.
  const { error: chunksError } = await supabase.from("chunks").insert(
    chunks.map((content, chunk_index) => ({ document_id: documentId, chunk_index, content, embedding: embeddings[chunk_index] })),
  );
  if (chunksError) return discard(KB_MESSAGES.chunks);

  const backfill = await backfillEmbeddings(stale, embeddings.slice(chunks.length));
  return { id: documentId, title: input.title, chunks: chunks.length, ...backfill };
}

function validEmbedding(embedding: unknown): embedding is number[] {
  return Array.isArray(embedding) && embedding.length === EMBEDDING_DIMENSIONS && embedding.every(Number.isFinite);
}

// Uzupełnia puste embeddingi starszych fragmentów. Warunek embedding IS NULL chroni przed
// nadpisaniem wektora zapisanego w międzyczasie; usunięty fragment po prostu się pomija.
async function backfillEmbeddings(stale: StoredChunk[], embeddings: number[][]) {
  const supabase = getSupabase();
  const results = await Promise.all(stale.map(async (chunk, index) => {
    const { data, error } = await supabase.from("chunks").update({ embedding: embeddings[index] })
      .eq("id", chunk.id).is("embedding", null).select("id");
    if (error) return "failed";
    return data?.length ? "updated" : "skipped";
  }));
  return {
    backfilled: results.filter(result => result === "updated").length,
    backfillFailed: results.filter(result => result === "failed").length,
  };
}
