// Wspólne dla serwera i przeglądarki: nazwy etapów importu i odczyt strumienia zdarzeń NDJSON.
import type { ImportStage } from "./knowledge-base";

export const STAGES: ImportStage[] = ["split", "embed", "save"];

export const STAGE_LABELS: Record<ImportStage, string> = {
  split: "Dzielę tekst…",
  embed: "Tworzę embeddingi…",
  save: "Zapisuję…",
};

// Nazwa etapu w komunikacie o błędzie: „na etapie: tworzenie embeddingów”.
export const STAGE_NAMES: Record<ImportStage, string> = {
  split: "dzielenie tekstu",
  embed: "tworzenie embeddingów",
  save: "zapisywanie",
};

export type SavedDocumentSummary = {
  id: number; title: string; created_at: string; chunks: number;
  backfilled: number; backfillFailed: number; replaced: number; replaceFailed: number;
};

export type UploadStreamEvent =
  | { type: "stage"; stage: ImportStage }
  | { type: "done"; document: SavedDocumentSummary }
  | { type: "error"; stage: ImportStage; message: string };

// Czyta zdarzenia linia po linii w miarę, jak przychodzą. Zwraca ostatnie zdarzenie
// (done/error) albo null, gdy strumień urwał się przed końcem importu.
export async function readUploadEvents(body: ReadableStream<Uint8Array>,
  onEvent: (event: UploadStreamEvent) => void): Promise<UploadStreamEvent | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", last: UploadStreamEvent | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as UploadStreamEvent;
    onEvent(event);
    if (event.type !== "stage") last = event;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  handle(buffer + decoder.decode());
  return last;
}
