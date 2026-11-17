"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ANALYSIS_ERRORS, isAnalysisErrorCode } from "../lib/analysis-errors";
import { analysisSchema, type Analysis } from "../lib/analysis-schema";

const CATEGORY_LABELS = {
  sales: "Oferta i cena",
  support: "Problem techniczny",
  billing: "Płatność lub zwrot",
  unknown: "Brak rozpoznanej sprawy",
} as const;

export default function AnalysisPanel({ leaving, onBusyChange }: {
  leaving: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
  }, []);

  useEffect(() => {
    if (leaving) activeRequest.current?.abort();
  }, [leaving]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || leaving || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    onBusyChange(true);
    setResult(null);
    setError("");

    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(75_000)]);
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "analyze", message: text }),
        signal,
      });
      if (response.status === 401) {
        window.location.replace("/");
        return;
      }
      const body = await response.json();
      signal.throwIfAborted();
      if (!response.ok) {
        const code: unknown = body?.error?.code;
        setError(isAnalysisErrorCode(code) ? ANALYSIS_ERRORS[code] : ANALYSIS_ERRORS.provider);
        return;
      }
      const validated = analysisSchema.safeParse(body?.result);
      if (!validated.success) {
        setError(ANALYSIS_ERRORS.invalid_output);
        return;
      }
      setResult(validated.data);
    } catch (failure) {
      if (activeRequest.current !== controller) return;
      const interrupted = controller.signal.aborted ||
        (failure instanceof DOMException && ["AbortError", "TimeoutError"].includes(failure.name));
      setError(interrupted ? ANALYSIS_ERRORS.interrupted : ANALYSIS_ERRORS.provider);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <section aria-labelledby="analysis-heading">
      <h2 id="analysis-heading">Analiza wiadomości Studio Nova</h2>
      <p>Wklej wiadomość klienta. Otrzymasz kategorię, priorytet i szkic odpowiedzi.</p>
      <form onSubmit={analyze}>
        <label htmlFor="analysis-message">Wiadomość klienta</label>
        <textarea
          id="analysis-message"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setResult(null);
            setError("");
          }}
          rows={6}
          maxLength={12_000}
          required
          disabled={busy || leaving}
        />
        <div className="analysis-actions">
          <button type="submit" disabled={busy || leaving || !message.trim()}>
            {busy ? "Analizuję…" : "Analizuj wiadomość"}
          </button>
          {busy && <button type="button" onClick={() => activeRequest.current?.abort()} disabled={leaving}>Przerwij</button>}
        </div>
      </form>
      <div aria-live="polite" aria-busy={busy}>
        {busy && <p className="status" role="status">Analizuję wiadomość. Czekam na pełny, poprawny wynik…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {result && (
          <section className="analysis-result" aria-labelledby="result-heading">
            <h3 id="result-heading">Szkic do wykorzystania przez pracownika</h3>
            <dl>
              <dt>Kategoria</dt>
              <dd>{CATEGORY_LABELS[result.category]} ({result.category})</dd>
              <dt>Priorytet</dt>
              <dd>{result.priority === "high" ? "Wysoki (high)" : "Zwykły (normal)"}</dd>
              <dt>Status sprawdzenia</dt>
              <dd>{result.needs_review
                ? "Wymaga sprawdzenia przez pracownika (needs_review = true)"
                : "Nie wymaga dodatkowego sprawdzenia (needs_review = false)"}</dd>
            </dl>
            <h4>Szkic odpowiedzi</h4>
            <p className="analysis-draft">{result.draft}</p>
            <p className="status">To zawsze szkic, również gdy nie wymaga dodatkowego sprawdzenia. Wiadomość nie została wysłana; nie wykonano rezerwacji ani operacji płatniczych.</p>
          </section>
        )}
      </div>
    </section>
  );
}
