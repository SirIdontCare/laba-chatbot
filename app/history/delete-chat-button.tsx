"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteChatButton({ chatId, title }: { chatId: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (!window.confirm(`Usunąć rozmowę „${title}” wraz ze wszystkimi wiadomościami?`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/history?chat=${chatId}`, { method: "DELETE" });
      if (response.status === 401) { window.location.replace("/"); return; }
      if (!response.ok) throw new Error();
      router.refresh();
    } catch {
      setError("Nie udało się usunąć rozmowy. Spróbuj ponownie.");
    } finally { setBusy(false); }
  }
  return <div><button type="button" className="secondary-button" onClick={remove} disabled={busy}
    aria-label={`Usuń rozmowę: ${title}`}>{busy ? "Usuwam…" : "Usuń"}</button>
    {error && <p role="alert" className="error">{error}</p>}</div>;
}
