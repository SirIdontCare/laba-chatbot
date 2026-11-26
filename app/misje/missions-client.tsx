"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountSummary } from "../../lib/account";
import {
  isMissionErrorCode, MISSION_ERRORS, MISSION_TIME_LIMIT_MS, missionResponseSchema, missionResultSchema,
  type MissionSource, type PublicMission,
} from "../../lib/mission-schema";
import ThemeToggle from "../theme-toggle";
import UserMenu from "../user-menu";

type Report = { result: Record<string, string | string[]>; sources: MissionSource[] };

function MissionReport({ mission, report }: { mission: PublicMission; report: Report }) {
  return <section className="analysis-result mission-report" aria-labelledby="report-heading">
    <h3 id="report-heading">{mission.name}</h3>
    {mission.sections.map(section => {
      const value = report.result[section.key];
      return <div key={section.key}>
        <h4>{section.title}</h4>
        {typeof value === "string" ? <p>{value}</p> : <ul>{value.map((point, index) => <li key={index}>{point}</li>)}</ul>}
      </div>;
    })}
    <h4>Źródła</h4>
    {report.sources.length > 0
      ? <ol className="mission-sources">{report.sources.map(source => <li key={source.url}>
        <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
        <span className="status"> {new URL(source.url).hostname}</span>
      </li>)}</ol>
      : <p className="error">Wyszukiwanie w internecie nie zwróciło żadnych stron. Raport nie opiera się na sprawdzonych źródłach — traktuj go ostrożnie.</p>}
    <p className="status">Raport jest tylko tekstem na ekranie. Nic nie zostało zapisane ani wysłane.</p>
  </section>;
}

export default function MissionsClient({ account, missions }: { account: AccountSummary; missions: PublicMission[] }) {
  const [selectedId, setSelectedId] = useState(missions[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const mission = missions.find(item => item.id === selectedId);

  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => { if (leaving) activeRequest.current?.abort(); }, [leaving]);

  function choose(id: string) {
    if (busy) return;
    setSelectedId(id);
    setValues({});
    setReport(null);
    setError("");
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mission || busy || leaving || activeRequest.current) return;
    const input = Object.fromEntries(mission.fields.map(field => [field.name, (values[field.name] ?? "").trim()]));
    if (mission.fields.some(field => !input[field.name])) { setError(MISSION_ERRORS.input); return; }
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setReport(null);
    setError("");
    try {
      // Serwer przerywa misję po minucie; przeglądarka czeka chwilę dłużej na jego odpowiedź.
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MISSION_TIME_LIMIT_MS + 20_000)]);
      const response = await fetch("/api/misje", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ missionId: mission.id, input }),
        signal,
      });
      if (response.status === 401) {
        window.location.replace("/login?next=%2Fmisje");
        return;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code: unknown = body?.error?.code;
        setError(isMissionErrorCode(code) ? MISSION_ERRORS[code] : MISSION_ERRORS.provider);
        return;
      }
      // Ponowne sprawdzenie sekcji i źródeł w przeglądarce, zanim cokolwiek pokażemy.
      const shape = missionResponseSchema.safeParse(body);
      const sections = shape.success ? missionResultSchema(mission.sections).safeParse(shape.data.result) : null;
      if (!shape.success || !sections?.success) { setError(MISSION_ERRORS.invalid_output); return; }
      setReport(shape.data);
    } catch (failure) {
      if (activeRequest.current !== controller) return;
      const timedOut = failure instanceof DOMException && failure.name === "TimeoutError";
      setError(timedOut ? MISSION_ERRORS.timeout : controller.signal.aborted ? MISSION_ERRORS.interrupted : MISSION_ERRORS.provider);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  return <main className="chat">
    <header className="chat-header">
      <div><p className="eyebrow">OD DANYCH DO WYNIKU</p><h1>Misje agenta</h1>
        <p className="header-description">Wybierz misję, podaj dane i przeczytaj gotowy wynik.</p></div>
      <div className="header-actions"><Link href="/">← Wróć do czatu</Link><ThemeToggle />
        <UserMenu account={account} onLeavingChange={setLeaving} /></div>
    </header>

    <section aria-labelledby="missions-heading">
      <h2 id="missions-heading">Wybierz misję</h2>
      <ul className="mission-list">
        {missions.map(item => <li key={item.id}>
          <button type="button" className="mission-choice" aria-pressed={item.id === selectedId}
            onClick={() => choose(item.id)} disabled={busy || leaving}>
            <strong>{item.name}</strong>
            <span>{item.description}</span>
          </button>
        </li>)}
      </ul>
    </section>

    {mission && <section aria-labelledby="mission-form-heading">
      <h2 id="mission-form-heading">Misja: {mission.name}</h2>
      <form onSubmit={run}>
        {mission.fields.map(field => {
          const value = values[field.name] ?? "";
          return <div key={field.name} className="mission-field">
            <label htmlFor={`mission-${field.name}`}>{field.label}</label>
            <input id={`mission-${field.name}`} value={value} maxLength={field.maxLength} placeholder={field.placeholder}
              required disabled={busy || leaving}
              onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setError(""); }} />
            <p className="status">{value.length}/{field.maxLength} znaków</p>
          </div>;
        })}
        <div className="analysis-actions">
          <button type="submit" disabled={busy || leaving || mission.fields.some(field => !(values[field.name] ?? "").trim())}>
            {busy ? "Agent pracuje…" : "Uruchom misję"}
          </button>
        </div>
      </form>
      <div aria-live="polite" aria-busy={busy}>
        {busy && <p className="status" role="status">Agent pracuje… To może potrwać do minuty.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {report && <MissionReport mission={mission} report={report} />}
      </div>
    </section>}
  </main>;
}
