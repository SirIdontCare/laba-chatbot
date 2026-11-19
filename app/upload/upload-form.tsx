"use client";

import { useState, type FormEvent } from "react";

const MAX_TITLE = 200;
const MAX_CONTENT = 20_000;

// genitive: forma po „embeddingi …” (1 fragmentu, 2 fragmentów, 5 fragmentów).
function fragmentWord(count: number, genitive = false) {
  if (genitive) return count === 1 ? "fragmentu" : "fragmentów";
  if (count === 1) return "fragment";
  const last = count % 10, lastTwo = count % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "fragmenty" : "fragmentów";
}

export default function UploadForm() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!title.trim()) { setError("Wpisz tytuł dokumentu."); return; }
    if (!content.trim()) { setError("Wklej treść dokumentu."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/upload", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content }) });
      if (response.status === 401) { window.location.replace("/upload"); return; }
      if (!response.ok) { setError(await response.text() || "Nie udało się zapisać dokumentu."); return; }
      const saved = await response.json() as { title: string; chunks: number; backfilled: number; backfillFailed: number };
      let message = `Zapisano dokument „${saved.title}”: ${saved.chunks} ${fragmentWord(saved.chunks)} z embeddingami.`;
      if (saved.backfilled) message += ` Uzupełniono też embeddingi ${saved.backfilled} ${fragmentWord(saved.backfilled, true)} zapisanych wcześniej.`;
      setSuccess(message);
      if (saved.backfillFailed) {
        setError(`Nie udało się uzupełnić embeddingów ${saved.backfillFailed} ${fragmentWord(saved.backfillFailed, true)} zapisanych wcześniej. Spróbuję ponownie przy następnym imporcie.`);
      }
      setTitle("");
      setContent("");
    } catch {
      setError("Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="upload-form" onSubmit={submit} noValidate>
    <label>Tytuł
      <input value={title} onChange={event => setTitle(event.target.value)} maxLength={MAX_TITLE} disabled={busy} />
    </label>
    <label>Treść
      <textarea value={content} onChange={event => setContent(event.target.value)} maxLength={MAX_CONTENT}
        rows={18} disabled={busy} />
    </label>
    <p className="upload-counter">{content.length.toLocaleString("pl-PL")} / {MAX_CONTENT.toLocaleString("pl-PL")} znaków</p>
    <button disabled={busy}>{busy ? "Zapisuję…" : "Dodaj do bazy wiedzy"}</button>
    {error && <p role="alert" className="error">{error}</p>}
    {success && <p role="status">{success}</p>}
  </form>;
}
