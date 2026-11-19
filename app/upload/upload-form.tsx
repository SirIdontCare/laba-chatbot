"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ExistingDocument, ImportStage } from "../../lib/knowledge-base";
import { readUploadEvents, STAGE_LABELS, STAGE_NAMES, STAGES, type SavedDocumentSummary } from "../../lib/upload-stream";

const MAX_TITLE = 200;
const MAX_CONTENT = 20_000;
const versionDate = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw" });

// genitive: forma po „embeddingi …” (1 fragmentu, 2 fragmentów, 5 fragmentów).
function fragmentWord(count: number, genitive = false) {
  if (genitive) return count === 1 ? "fragmentu" : "fragmentów";
  if (count === 1) return "fragment";
  const last = count % 10, lastTwo = count % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "fragmenty" : "fragmentów";
}

function successMessage(saved: SavedDocumentSummary) {
  let message = saved.replaced
    ? `Zastąpiono dokument „${saved.title}” nową wersją: ${saved.chunks} ${fragmentWord(saved.chunks)} z embeddingami.`
    : `Zapisano dokument „${saved.title}”: ${saved.chunks} ${fragmentWord(saved.chunks)} z embeddingami.`;
  if (saved.backfilled) message += ` Uzupełniono też embeddingi ${saved.backfilled} ${fragmentWord(saved.backfilled, true)} zapisanych wcześniej.`;
  return message;
}

function warnings(saved: SavedDocumentSummary) {
  const out: string[] = [];
  if (saved.replaceFailed) out.push("Nie udało się usunąć poprzedniej wersji dokumentu, więc w bazie są teraz obie. Usuń starszą przyciskiem „Usuń” na liście poniżej.");
  if (saved.backfillFailed) out.push(`Nie udało się uzupełnić embeddingów ${saved.backfillFailed} ${fragmentWord(saved.backfillFailed, true)} zapisanych wcześniej. Spróbuję ponownie przy następnym imporcie.`);
  return out.join(" ");
}

export default function UploadForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  // Etap zgłoszony przez serwer; "check" = sprawdzanie sesji i tytułu przed startem importu.
  const [stage, setStage] = useState<ImportStage | "check" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // Blokada synchroniczna: drugi klik przed odświeżeniem przycisku nie wyśle dokumentu ponownie.
  const inFlight = useRef(false);

  async function send(replace: boolean): Promise<void> {
    setStage("check");
    const response = await fetch("/api/upload", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content, replace }) });
    if (response.status === 401) { window.location.replace("/upload"); return; }
    if (response.status === 409) {
      const { existing } = await response.json() as { existing: ExistingDocument[] };
      const latest = existing[0];
      const confirmed = window.confirm(`Dokument „${latest.title}” jest już w bazie (wersja z ${versionDate.format(new Date(latest.created_at))}, `
        + `${latest.chunks} ${fragmentWord(latest.chunks)}). Zastąpić go nową wersją? Stare fragmenty zostaną usunięte `
        + "dopiero po udanym zapisie nowej wersji.");
      if (confirmed) return send(true);
      setStage(null);
      setSuccess("Nic nie zmieniono. Jeśli to inny dokument, nadaj mu inny tytuł.");
      return;
    }
    if (!response.ok || !response.body) {
      setStage(null);
      setError(`Import się nie rozpoczął. ${await response.text() || "Spróbuj ponownie za chwilę."}`);
      return;
    }
    let current: ImportStage = "split";
    const last = await readUploadEvents(response.body, event => {
      if (event.type === "stage") { current = event.stage; setStage(event.stage); }
    });
    setStage(null);
    if (last?.type === "done") {
      setSuccess(successMessage(last.document));
      setError(warnings(last.document));
      setTitle("");
      setContent("");
      router.refresh();
    } else if (last?.type === "error") {
      setError(`Import nie powiódł się na etapie: ${STAGE_NAMES[last.stage]}. ${last.message}`);
      router.refresh();
    } else {
      setError(`Połączenie przerwało się na etapie: ${STAGE_NAMES[current]}. Sprawdź na liście poniżej, czy dokument się zapisał, i w razie potrzeby spróbuj ponownie.`);
      router.refresh();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    setSuccess("");
    if (!title.trim()) { setError("Wpisz tytuł dokumentu."); return; }
    if (!content.trim()) { setError("Wklej treść dokumentu."); return; }
    inFlight.current = true;
    setBusy(true);
    try {
      await send(false);
    } catch {
      setStage(null);
      setError("Brak połączenia z serwerem. Sprawdź internet, a potem listę dokumentów poniżej, i spróbuj ponownie.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const stageIndex = stage && stage !== "check" ? STAGES.indexOf(stage) : -1;
  return <form className="upload-form" onSubmit={submit} noValidate aria-busy={busy}>
    <label>Tytuł (nazwa źródła)
      <input value={title} onChange={event => setTitle(event.target.value)} maxLength={MAX_TITLE} disabled={busy} />
    </label>
    <label>Treść
      <textarea value={content} onChange={event => setContent(event.target.value)} maxLength={MAX_CONTENT}
        rows={18} disabled={busy} />
    </label>
    <p className="upload-counter">{content.length.toLocaleString("pl-PL")} / {MAX_CONTENT.toLocaleString("pl-PL")} znaków</p>
    <button disabled={busy}>{busy ? "Importuję…" : "Dodaj do bazy wiedzy"}</button>
    {stage && <ol className="upload-stages" aria-label="Postęp importu">
      {STAGES.map((name, index) => <li key={name}
        data-state={index < stageIndex ? "done" : index === stageIndex ? "current" : "pending"}>
        {index < stageIndex ? "✓ " : ""}{STAGE_LABELS[name]}
      </li>)}
    </ol>}
    <p role="status" className="upload-stage-status">
      {stage === "check" ? "Sprawdzam dokument…" : stage ? STAGE_LABELS[stage] : success}
    </p>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}
