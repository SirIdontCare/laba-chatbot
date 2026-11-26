"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountSummary } from "../../lib/account";
import {
  citedNumbers, formatCompletedAt, isMissionErrorCode, layoutInputError, MISSION_ERRORS, MISSION_TIME_LIMIT_MS, missionResponseSchema, NO_DATA,
  parseCriteria, parseMissionResult, sourceLabel, type ComparisonResult, type MissionSection, type MissionSource, type PublicMission,
} from "../../lib/mission-schema";
import ThemeToggle from "../theme-toggle";
import UserMenu from "../user-menu";

type Report = { result: unknown; sources: MissionSource[]; completedAt: string };

// numbered: źródła ponumerowane [1], [2]… (Raport), z kotwicami dla odnośników w faktach.
function SourceList({ sources, empty, numbered = false }: { sources: MissionSource[]; empty: string; numbered?: boolean }) {
  if (!sources.length) return <p className="error">{empty}</p>;
  return <ol className={`mission-sources${numbered ? " numbered" : ""}`}>{sources.map((source, index) =>
    <li key={`${source.group ?? ""}${source.url}`} id={numbered ? `zrodlo-${index + 1}` : undefined}>
      {numbered && <span className="source-number">[{index + 1}]</span>}{" "}
      <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
      <span className="status"> {new URL(source.url).hostname}{source.group ? ` · ${source.group}` : ""}</span>
    </li>)}</ol>;
}

// Fakt z numerami źródeł na końcu: numery stają się odnośnikami do listy źródeł.
function CitedPoint({ text }: { text: string }) {
  const numbers = citedNumbers(text);
  if (!numbers.length) return <>{text}</>;
  const body = text.replace(/(?:\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\])+\s*\.?$/, "");
  return <>{body}{" "}{numbers.map(number => <a key={number} className="citation" href={`#zrodlo-${number}`}>[{number}]</a>)}</>;
}

function SectionsReport({ sections, result, sources }: { sections: MissionSection[]; result: Record<string, string | string[]>; sources: MissionSource[] }) {
  return <>
    {sections.map(section => {
      const value = result[section.key];
      if (typeof value === "string") return <div key={section.key}><h4>{section.title}</h4><p>{value}</p></div>;
      // Sekcja wymagająca źródeł jest pusta tylko wtedy, gdy wyszukiwanie nic nie zwróciło.
      if (!value.length) return null;
      return <div key={section.key}>
        <h4>{section.title}</h4>
        <ul>{value.map((point, index) => <li key={index}>
          {section.kind === "list" && section.cite ? <CitedPoint text={point} /> : point}
        </li>)}</ul>
      </div>;
    })}
    <h4>Źródła</h4>
    <SourceList numbered sources={sources} empty="Wyszukiwanie w internecie nie zwróciło żadnych stron, więc raport nie zawiera faktów." />
  </>;
}

// Tabela budowana z pól sprawdzonych na serwerze: firmy w kolumnach, kryteria w wierszach.
function ComparisonReport({ result, sources }: { result: ComparisonResult; sources: MissionSource[] }) {
  const { company, condition, reason } = result.recommendation;
  return <>
    <div className="comparison-scroll" role="region" aria-label="Tabela porównania" tabIndex={0}>
      <table className="comparison-table">
        <thead><tr><th scope="col">Kryterium</th>{result.companies.map(name => <th key={name} scope="col">{name}</th>)}</tr></thead>
        <tbody>{result.criteria.map((criterion, row) => <tr key={criterion} className={result.mixedSources[row] ? "mixed-sources" : undefined}>
          <th scope="row">{criterion}{result.mixedSources[row] && <span className="cell-source" title="Wartości z różnych źródeł">⚠ różne źródła</span>}</th>
          {result.cells[row].map((item, column) => item.value === NO_DATA
            ? <td key={column} className="no-data">{NO_DATA}</td>
            : <td key={column}>{item.value}
              <span className={`cell-source${item.independent === false ? " own-data" : ""}`}>{sourceLabel(item)}</span></td>)}
        </tr>)}</tbody>
      </table>
    </div>
    {result.notes.map(note => <p key={note} className="status">{note}</p>)}
    <h4>Rekomendacja</h4>
    {company && condition
      ? <p><strong>{company}</strong> — najlepszy wybór, jeśli zależy Ci na {condition}. {reason}</p>
      : <p className="error">{reason}</p>}
    <h4>Źródła</h4>
    <SourceList sources={sources} empty="Wyszukiwanie w internecie nie zwróciło żadnych stron. Porównanie nie opiera się na sprawdzonych źródłach." />
  </>;
}

function MissionReport({ mission, report }: { mission: PublicMission; report: Report }) {
  return <section className="analysis-result mission-report" aria-labelledby="report-heading">
    <h3 id="report-heading">{mission.name}</h3>
    {mission.layout.type === "sections"
      ? <SectionsReport sections={mission.layout.sections} result={report.result as Record<string, string | string[]>} sources={report.sources} />
      : <ComparisonReport result={report.result as ComparisonResult} sources={report.sources} />}
    <p className="mission-meta">Misja wykonana: <time dateTime={report.completedAt}>{formatCompletedAt(report.completedAt)}</time></p>
    <p className="status">Wynik jest tylko tekstem na ekranie. Nic nie zostało zapisane ani wysłane.</p>
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
    const layoutError = layoutInputError(mission.layout, input);
    if (layoutError) { setError(MISSION_ERRORS[layoutError]); return; }
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
      const checked = shape.success ? parseMissionResult(mission.layout, shape.data.result, shape.data.sources.length) : null;
      if (!shape.success || !checked?.success) { setError(MISSION_ERRORS.invalid_output); return; }
      setReport({ result: checked.data, sources: shape.data.sources, completedAt: shape.data.completedAt });
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
            <p className="status">{field.hint ? `${field.hint} ` : ""}{value.length}/{field.maxLength} znaków
              {mission.layout.type === "comparison" && field.name === mission.layout.criteriaField
                ? ` · kryteriów: ${parseCriteria(value).length}` : ""}</p>
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
