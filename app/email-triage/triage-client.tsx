"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountSummary } from "../../lib/account";
import {
  isTriageErrorCode, splitEmails, TRIAGE_ERRORS, TRIAGE_MAX_EMAILS, TRIAGE_MAX_INPUT_CHARS,
  triageResponseSchema, type TriageCard,
} from "../../lib/email-triage-schema";
import ThemeToggle from "../theme-toggle";
import UserMenu from "../user-menu";

const PLACEHOLDER = `Od: Anna Kowalska <anna@example.com>
Temat: Pytanie o cennik
Dzień dobry, ile kosztuje pakiet dla 5 osób?
---
Od: Jan Nowak
Temat: Nie działa logowanie
Od rana nie mogę się zalogować do panelu.`;

function CopyDraftButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return <div className="analysis-actions">
    <button type="button" className="secondary-button" onClick={copy}>Kopiuj szkic</button>
    <span className="status" role="status">
      {state === "copied" ? "Skopiowano do schowka." : state === "failed" ? "Nie udało się skopiować. Zaznacz tekst i skopiuj ręcznie." : ""}
    </span>
  </div>;
}

function ResultCard({ card, number }: { card: TriageCard; number: number }) {
  if (!card.ok) {
    return <li className="analysis-result">
      <h3>Mail {number}</h3>
      <p className="error" role="alert">{card.error.message}</p>
    </li>;
  }
  const { result } = card;
  return <li className="analysis-result">
    <h3>Mail {number}: {result.temat}</h3>
    <dl>
      <dt>Nadawca</dt><dd>{result.nadawca}</dd>
      <dt>Temat</dt><dd>{result.temat}</dd>
      <dt>Kategoria</dt><dd>{result.kategoria}</dd>
      <dt>Priorytet</dt><dd>{result.priorytet}</dd>
      <dt>Uzasadnienie priorytetu</dt><dd>{result.uzasadnienie}</dd>
    </dl>
    <h4>Szkic odpowiedzi</h4>
    <p className="analysis-draft">{result.szkic}</p>
    <CopyDraftButton text={result.szkic} />
  </li>;
}

export default function TriageClient({ account }: { account: AccountSummary }) {
  const [text, setText] = useState("");
  const [cards, setCards] = useState<TriageCard[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => { if (leaving) activeRequest.current?.abort(); }, [leaving]);

  const count = splitEmails(text).length;

  async function sort(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || leaving || activeRequest.current) return;
    if (count === 0) { setError(TRIAGE_ERRORS.input); return; }
    if (count > TRIAGE_MAX_EMAILS) { setError(TRIAGE_ERRORS.tooMany); return; }
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setCards(null);
    setError("");
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)]);
      const response = await fetch("/api/email-triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      });
      if (response.status === 401) {
        window.location.replace("/login?next=%2Femail-triage");
        return;
      }
      const body = await response.json();
      if (!response.ok) {
        const code: unknown = body?.error?.code;
        setError(isTriageErrorCode(code) ? TRIAGE_ERRORS[code] : TRIAGE_ERRORS.provider);
        return;
      }
      // Ponowne sprawdzenie pól także w przeglądarce, zanim cokolwiek pokażemy.
      const validated = triageResponseSchema.safeParse(body);
      if (!validated.success) { setError(TRIAGE_ERRORS.invalid_output); return; }
      setCards(validated.data.cards);
    } catch (failure) {
      if (activeRequest.current !== controller) return;
      const interrupted = controller.signal.aborted ||
        (failure instanceof DOMException && ["AbortError", "TimeoutError"].includes(failure.name));
      setError(interrupted ? TRIAGE_ERRORS.interrupted : TRIAGE_ERRORS.provider);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  return <main className="chat">
    <header className="chat-header">
      <div><p className="eyebrow">MISJA AGENTA</p><h1>Triage maili</h1>
        <p className="header-description">Kategoria, priorytet i szkic odpowiedzi dla każdego maila.</p></div>
      <div className="header-actions"><Link href="/">← Wróć do czatu</Link><ThemeToggle />
        <UserMenu account={account} onLeavingChange={setLeaving} /></div>
    </header>
    <section aria-labelledby="triage-heading">
      <h2 id="triage-heading">Wklej maile</h2>
      <p>Kilka maili oddziel linią zawierającą tylko trzy myślniki (<code>---</code>). Najwyżej {TRIAGE_MAX_EMAILS} maili naraz.
        Agent niczego nie wysyła: wynik to tekst do przeczytania i skopiowania.</p>
      <form onSubmit={sort}>
        <label htmlFor="triage-text">Maile</label>
        <textarea id="triage-text" value={text} rows={16} maxLength={TRIAGE_MAX_INPUT_CHARS} placeholder={PLACEHOLDER}
          onChange={(event) => { setText(event.target.value); setError(""); }} disabled={busy || leaving} />
        <p className="status">Wykryte maile: {count}{count > TRIAGE_MAX_EMAILS ? ` (limit ${TRIAGE_MAX_EMAILS})` : ""}</p>
        <div className="analysis-actions">
          <button type="submit" disabled={busy || leaving || count === 0}>{busy ? "Agent sortuje…" : "Posortuj"}</button>
        </div>
      </form>
      <div aria-live="polite" aria-busy={busy}>
        {busy && <p className="status" role="status">Agent sortuje…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {cards && <ol className="triage-cards">
          {cards.map((card, index) => <ResultCard key={index} card={card} number={index + 1} />)}
        </ol>}
        {cards && <p className="status">To są szkice. Nic nie zostało wysłane.</p>}
      </div>
    </section>
  </main>;
}
