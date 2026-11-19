"use client";

import { useState, type FormEvent } from "react";
import { PROFILE_PREFERENCES } from "../../lib/profile-preferences";

export default function ProfileEditor({ profile }: {
  profile: { name: string | null; preferences: Record<string, unknown> };
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preferenceRows = {
    ...Object.fromEntries(PROFILE_PREFERENCES.map(item => [item.key, ""])),
    ...profile.preferences,
  };
  async function update(body: object) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/profile", { method: "PATCH",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 401) { window.location.replace("/"); return; }
      if (!response.ok) throw new Error();
      window.location.reload();
    } catch { setError("Nie udało się zmienić profilu. Spróbuj ponownie."); setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>, key?: string) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("value") ?? "").trim();
    void update(key ? { action: "preference", key, value } : { action: "name", value: value || null });
  }
  return <section>
    <form onSubmit={event => save(event)} className="profile-row">
      <label>Imię<input name="value" defaultValue={profile.name ?? ""} maxLength={150} disabled={busy} /></label>
      <button disabled={busy}>Zapisz imię</button>
      <button type="button" disabled={busy || !profile.name} onClick={() => void update({ action: "name", value: null })}>Usuń imię</button>
    </form>
    <h2>Preferencje</h2>
    {Object.entries(preferenceRows).map(([key, value]) => <form key={key} className="profile-row" onSubmit={event => save(event, key)}>
      <label>{PROFILE_PREFERENCES.find(item => item.key === key)?.label ?? key.replaceAll("_", " ")}<input name="value" required maxLength={500} disabled={busy}
        placeholder="Jeszcze nie podano"
        defaultValue={typeof value === "string" ? value : JSON.stringify(value)} /></label>
      <button disabled={busy}>Zapisz</button>
      <button type="button" disabled={busy || !value} onClick={() => void update({ action: "preference", key, value: null })}>Usuń</button>
    </form>)}
    <button type="button" className="secondary-button" disabled={busy} onClick={() => {
      if (window.confirm("Wyczyścić imię i wszystkie preferencje?")) void update({ action: "clear" });
    }}>Wyczyść cały profil</button>
    {busy && <p role="status">Zapisuję zmiany…</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
