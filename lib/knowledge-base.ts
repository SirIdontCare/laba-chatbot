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
  // true = użytkownik potwierdził zastąpienie dokumentu o tym samym tytule.
  replace: z.boolean().optional(),
});
export type UploadInput = z.infer<typeof uploadSchema>;

// Etapy importu w kolejności; serwer zgłasza każdy z nich, zanim go wykona.
export type ImportStage = "split" | "embed" | "save";

// Błąd z komunikatem po polsku (co się stało i co zrobić), który można pokazać użytkownikowi.
export class KnowledgeBaseError extends Error {
  constructor(message: string, readonly stage: ImportStage) {
    super(message);
    this.name = "KnowledgeBaseError";
  }
}

export const KB_MESSAGES = {
  empty: "Tekst nie zawiera akapitów do zapisania. Wklej treść dokumentu i spróbuj ponownie.",
  config: "Na serwerze brakuje konfiguracji modelu embeddingów (OPENROUTER_EMBEDDING_MODEL). Nic nie zostało zapisane. Poproś administratora o uzupełnienie konfiguracji.",
  embeddings: "Model embeddingów nie zwrócił poprawnych wektorów. Nic nie zostało zapisane. Spróbuj ponownie za chwilę; jeśli błąd się powtarza, sprawdź konfigurację modelu embeddingów.",
  document: "Nie udało się zapisać dokumentu w bazie wiedzy. Nic nie zostało zapisane. Spróbuj ponownie za chwilę.",
  chunks: "Nie udało się zapisać fragmentów dokumentu. Nowa wersja nie została zapisana. Spróbuj ponownie za chwilę.",
  cleanup: "Nie udało się zapisać fragmentów, a niedokończona nowa wersja mogła zostać w bazie. Sprawdź listę dokumentów poniżej, usuń niepełną wersję i spróbuj ponownie.",
  keptOld: "Poprzednia wersja dokumentu pozostała bez zmian.",
} as const;

export type ExistingDocument = { id: number; title: string; created_at: string; chunks: number };

type DocumentRow = { id: number; title: string; created_at: string; chunks: { count: number }[] | null };
const toDocument = (row: DocumentRow): ExistingDocument =>
  ({ id: row.id, title: row.title, created_at: row.created_at, chunks: row.chunks?.[0]?.count ?? 0 });

// Lista dokumentów: tytuł = nazwa źródła, data dodania = wersja, liczba fragmentów.
export async function listDocuments(): Promise<ExistingDocument[]> {
  const { data, error } = await getSupabase().from("documents")
    .select("id, title, created_at, chunks(count)").order("created_at", { ascending: false });
  if (error || !Array.isArray(data)) throw new Error("Nie udało się wczytać dokumentów.");
  return (data as DocumentRow[]).map(toDocument);
}

export async function findDocumentsByTitle(title: string): Promise<ExistingDocument[]> {
  const { data, error } = await getSupabase().from("documents")
    .select("id, title, created_at, chunks(count)").eq("title", title).order("created_at", { ascending: false });
  if (error || !Array.isArray(data)) throw new Error("Nie udało się sprawdzić dokumentów.");
  return (data as DocumentRow[]).map(toDocument);
}

// Usuwa dokument z fragmentami. Zwraca false, gdy dokumentu już nie było.
export async function deleteDocument(id: number): Promise<boolean> {
  const supabase = getSupabase();
  const { error: chunksError } = await supabase.from("chunks").delete().eq("document_id", id);
  if (chunksError) throw new Error("Nie udało się usunąć fragmentów.");
  const { data, error } = await supabase.from("documents").delete().eq("id", id).select("id");
  if (error) throw new Error("Nie udało się usunąć dokumentu.");
  return Boolean(data?.length);
}

type StoredChunk = { id: number; content: string };
type SaveOptions = { replaceIds?: number[]; onStage?: (stage: ImportStage) => void | Promise<void> };

// Import dokumentu w trzech etapach: podział tekstu, embeddingi (jedno embedMany dla nowych fragmentów
// i starszych z pustym embeddingiem), zapis. Nowa wersja trafia do bazy dopiero z kompletem wektorów;
// stare wersje (replaceIds) usuwamy dopiero po udanym zapisie nowej, więc błąd ich nie narusza.
export async function saveDocument(input: UploadInput, { replaceIds = [], onStage }: SaveOptions = {}) {
  const keep = replaceIds.length ? ` ${KB_MESSAGES.keptOld}` : "";

  await onStage?.("split");
  const chunks = splitIntoChunks(input.content);
  if (!chunks.length) throw new KnowledgeBaseError(KB_MESSAGES.empty, "split");

  await onStage?.("embed");
  let model;
  try { model = embeddingModel(); } catch { throw new KnowledgeBaseError(KB_MESSAGES.config + keep, "embed"); }
  const supabase = getSupabase();
  // Starsze fragmenty bez embeddingu (bez fragmentów zastępowanych wersji); błąd odczytu nie blokuje importu.
  const { data: pending } = await supabase.from("chunks").select("id, content, document_id")
    .is("embedding", null).order("id").limit(BACKFILL_LIMIT);
  const stale: StoredChunk[] = (Array.isArray(pending) ? pending : [])
    .filter(chunk => !replaceIds.includes(chunk.document_id));
  let embeddings: number[][];
  try {
    ({ embeddings } = await embedMany({ model, values: [...chunks, ...stale.map(chunk => chunk.content)] }));
  } catch {
    throw new KnowledgeBaseError(KB_MESSAGES.embeddings + keep, "embed");
  }
  if (embeddings.length !== chunks.length + stale.length || !embeddings.every(validEmbedding)) {
    throw new KnowledgeBaseError(KB_MESSAGES.embeddings + keep, "embed");
  }

  await onStage?.("save");
  const { data: document, error } = await supabase
    .from("documents").insert({ title: input.title }).select("id, created_at").single();
  if (error || !document) throw new KnowledgeBaseError(KB_MESSAGES.document + keep, "save");
  const documentId = document.id as number;

  // Nowe fragmenty od razu z embeddingami: jeden insert, wszystko albo nic.
  const { error: chunksError } = await supabase.from("chunks").insert(
    chunks.map((content, chunk_index) => ({ document_id: documentId, chunk_index, content, embedding: embeddings[chunk_index] })),
  );
  if (chunksError) {
    let cleaned = false;
    try { await deleteDocument(documentId); cleaned = true; } catch {}
    throw new KnowledgeBaseError(cleaned ? KB_MESSAGES.chunks + keep : KB_MESSAGES.cleanup, "save");
  }

  const backfill = await backfillEmbeddings(stale, embeddings.slice(chunks.length));
  let replaced = 0, replaceFailed = 0;
  for (const id of replaceIds) {
    try { await deleteDocument(id); replaced++; } catch { replaceFailed++; }
  }
  return { id: documentId, title: input.title, created_at: document.created_at as string,
    chunks: chunks.length, ...backfill, replaced, replaceFailed };
}
export type SavedDocument = Awaited<ReturnType<typeof saveDocument>>;

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
