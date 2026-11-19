import "server-only";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// Model rozmowy: nazwa w zmiennej OPENROUTER_MODEL.
export function chatModelId(): string | undefined {
  return process.env.OPENROUTER_MODEL?.trim() || undefined;
}

// Model embeddingów dla bazy wiedzy (RAG): nazwa w zmiennej OPENROUTER_EMBEDDING_MODEL.
// Ten sam model służy do zapisu dokumentów (embedMany) i do pytań (embed).
// Sprawdzone 2026-11-19: openai/text-embedding-3-small zwraca wektor o długości 1536,
// zgodnie z kolumną chunks.embedding vector(1536) i funkcją match_chunks.
// Zmiana modelu = zmiana długości wektora: trzeba wtedy przebudować kolumnę i ponownie zapisać dokumenty.
export const EMBEDDING_DIMENSIONS = 1536;

export function embeddingModel() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const modelId = process.env.OPENROUTER_EMBEDDING_MODEL?.trim();
  if (!apiKey || !modelId) {
    throw new Error("Skonfiguruj OPENROUTER_API_KEY i OPENROUTER_EMBEDDING_MODEL na serwerze.");
  }
  return createOpenRouter({ apiKey }).textEmbeddingModel(modelId);
}
