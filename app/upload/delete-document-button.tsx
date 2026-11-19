"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteDocumentButton({ documentId, title }: { documentId: number; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (!window.confirm(`Usunąć dokument „${title}” wraz ze wszystkimi fragmentami? Czat przestanie z niego korzystać.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/upload?document=${documentId}`, { method: "DELETE" });
      if (response.status === 401) { window.location.replace("/upload"); return; }
      if (!response.ok && response.status !== 404) throw new Error();
      router.refresh();
    } catch {
      setError("Nie udało się usunąć dokumentu. Spróbuj ponownie.");
    } finally { setBusy(false); }
  }
  return <div><button type="button" className="secondary-button" onClick={remove} disabled={busy}
    aria-label={`Usuń dokument: ${title}`}>{busy ? "Usuwam…" : "Usuń"}</button>
    {error && <p role="alert" className="error">{error}</p>}</div>;
}
