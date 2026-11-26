"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountSummary } from "../../lib/account";
import {
  citedNumbers, fieldInputError, formatCompletedAt, isMissionErrorCode, NO_DEADLINE, type MissionTask, layoutInputError, MISSION_ERRORS, MISSION_TIME_LIMIT_MS, missionResponseSchema, NO_DATA,
  parseCriteria, parseMissionResult, sourceLabel, type ComparisonResult, type MissionRunSummary, type MissionSection, type MissionSource, type PublicMission, type SavedMissionRun,
} from "../../lib/mission-schema";
import ThemeToggle from "../theme-toggle";
import UserMenu from "../user-menu";

// saved: wynik zapisany w historii; saveError: zapis się nie udał.
type Report = { result: unknown; sources: MissionSource[]; completedAt: string; saved?: boolean; saveError?: string };

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

// Zadania: kto, co, do kiedy. „brak terminu” jest wyróżnione, żeby było widać, co trzeba dopytać.
function TaskTable({ tasks }: { tasks: MissionTask[] }) {
  const withPerson = tasks.filter(task => task.kto !== NO_DATA).length;
  const noDeadline = tasks.filter(task => task.termin === NO_DEADLINE).length;
  return <>
    {/* Kontrola z kontraktu misji: osoba i termin albo „brak terminu” przy każdym zadaniu. */}
    <p className={withPerson === tasks.length ? "status" : "status task-warning"}>
      Kontrola: {withPerson} z {tasks.length} zadań ma osobę{withPerson < tasks.length ? ` (${tasks.length - withPerson} do uzupełnienia: „${NO_DATA}”)` : ""}
      {noDeadline ? `, ${noDeadline} bez terminu („${NO_DEADLINE}”)` : ", każde ma termin"}.
    </p>
    <div className="comparison-scroll" role="region" aria-label="Zadania" tabIndex={0}>
      <table className="comparison-table task-table">
        <thead><tr><th scope="col">Kto</th><th scope="col">Co</th><th scope="col">Do kiedy</th></tr></thead>
        <tbody>{tasks.map((task, index) => <tr key={index}>
          <th scope="row" className={task.kto === NO_DATA ? "no-data" : undefined}>{task.kto}</th><td><MarkNoData text={task.co} /></td>
          <td className={task.termin === NO_DEADLINE ? "no-data" : undefined}>{task.termin}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

// Wyróżnia „brak danych” w tekście, żeby od razu było widać, czego brakuje.
function MarkNoData({ text }: { text: string }) {
  const parts = text.split(new RegExp(`(${NO_DATA})`, "giu"));
  return <>{parts.map((part, index) => part.toLocaleLowerCase("pl-PL") === NO_DATA
    ? <mark key={index} className="no-data-mark">{part}</mark> : part)}</>;
}

// Rozwijany opis misji: cel, narzędzia, format wyniku i co sprawdzić przed użyciem.
function MissionAbout({ about }: { about: NonNullable<PublicMission["about"]> }) {
  return <details className="mission-about">
    <summary>Opis misji: cel, narzędzia, wynik i co sprawdzić</summary>
    <dl>
      <dt>Cel</dt><dd>{about.goal}</dd>
      <dt>Narzędzia</dt><dd>{about.tools}</dd>
      <dt>Format wyniku</dt><dd>{about.output}</dd>
      <dt>Sprawdź przed użyciem wyniku</dt><dd>{about.check}</dd>
    </dl>
  </details>;
}

function SectionsReport({ sections, result, sources, webSearch }: {
  sections: MissionSection[]; result: Record<string, unknown>; sources: MissionSource[]; webSearch: boolean;
}) {
  return <>
    {sections.map(section => {
      const value = result[section.key];
      if (section.kind === "text") return <div key={section.key}><h4>{section.title}</h4><p>{value as string}</p></div>;
      const items = value as unknown[];
      // Pusta lista: tekst z definicji misji albo (bez niego) sekcja ukryta, np. fakty bez źródeł.
      if (!items.length) {
        return section.emptyText ? <div key={section.key}><h4>{section.title}</h4><p className="status"><MarkNoData text={section.emptyText} /></p></div> : null;
      }
      return <div key={section.key}>
        <h4>{section.title}</h4>
        {section.kind === "tasks"
          ? <TaskTable tasks={items as MissionTask[]} />
          : <ul>{(items as string[]).map((point, index) => <li key={index}>
            {section.cite ? <CitedPoint text={point} /> : <MarkNoData text={point} />}
          </li>)}</ul>}
      </div>;
    })}
    {webSearch
      ? <><h4>Źródła</h4>
        <SourceList numbered sources={sources} empty="Wyszukiwanie w internecie nie zwróciło żadnych stron, więc raport nie zawiera faktów." /></>
      : <p className="status">Agent pracował tylko na wklejonym tekście, bez internetu i innych narzędzi.</p>}
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
      ? <SectionsReport sections={mission.layout.sections} result={report.result as Record<string, unknown>} sources={report.sources} webSearch={mission.webSearch} />
      : <ComparisonReport result={report.result as ComparisonResult} sources={report.sources} />}
    <p className="mission-meta">Misja wykonana: <time dateTime={report.completedAt}>{formatCompletedAt(report.completedAt)}</time></p>
    {report.saveError && <p className="error" role="alert">{report.saveError}</p>}
    <p className="status">{report.saved
      ? "Wynik jest zapisany w Twojej historii misji (widzisz go tylko Ty). Nic nie zostało wysłane."
      : "Wynik jest tylko tekstem na ekranie. Nic nie zostało zapisane ani wysłane."}</p>
  </section>;
}

// Pięć ostatnich wykonań misji: kliknięcie otwiera zapisany wynik (/misje?run=…).
function RecentRuns({ runs, openedId }: { runs: MissionRunSummary[] | null; openedId?: string }) {
  return <section className="mission-runs" aria-labelledby="runs-heading">
    <h3 id="runs-heading">Ostatnie wykonania</h3>
    {runs === null
      ? <p className="error">Nie udało się wczytać historii misji. Odśwież stronę.</p>
      : runs.length === 0
        ? <p className="status">Brak zapisanych wykonań. Wynik pojawi się tu po pierwszym uruchomieniu misji.</p>
        : <ul className="history-list">{runs.map(run => <li key={run.id}>
          <Link href={`/misje?run=${encodeURIComponent(run.id)}`} aria-current={run.id === openedId ? "page" : undefined}>
            <strong>{formatCompletedAt(run.createdAt)}</strong>
            <span>{run.id === openedId ? "Otwarty wynik" : "Otwórz zapisany wynik"}</span>
          </Link>
        </li>)}</ul>}
  </section>;
}

export default function MissionsClient({ account, missions, runs: initialRuns, openedRun, runLoadError }: {
  account: AccountSummary; missions: PublicMission[]; runs: Record<string, MissionRunSummary[] | null>;
  openedRun: SavedMissionRun | null; runLoadError: boolean;
}) {
  const [selectedId, setSelectedId] = useState(openedRun?.mission ?? missions[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  // Otwarty zapisany wynik (z listy ostatnich wykonań) pokazujemy jak zwykły wynik misji.
  const [report, setReport] = useState<Report | null>(openedRun ? { ...openedRun.report, saved: true } : null);
  const [viewing, setViewing] = useState<SavedMissionRun | null>(openedRun);
  const [runs, setRuns] = useState(initialRuns);
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
    setViewing(null);
    setError("");
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mission || busy || leaving || activeRequest.current) return;
    const input = Object.fromEntries(mission.fields.map(field => [field.name, (values[field.name] ?? "").trim()]));
    if (mission.fields.some(field => !input[field.name])) { setError(MISSION_ERRORS.input); return; }
    const layoutError = fieldInputError(mission.fields, input) ?? layoutInputError(mission.layout, input);
    if (layoutError) { setError(MISSION_ERRORS[layoutError]); return; }
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setReport(null);
    setViewing(null);
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
        const detail: unknown = body?.error?.detail;
        // Bez JSON-a odpowiedź nie pochodzi z misji (np. limit czasu serwera na hostingu).
        const message = isMissionErrorCode(code) ? MISSION_ERRORS[code]
          : response.status === 504 ? MISSION_ERRORS.timeout : MISSION_ERRORS.provider;
        const text = typeof detail === "string" && detail ? detail : "";
        // Za mało danych: agent nie zgadywał, tylko napisał, czego brakuje.
        setError(code === "needs_input" ? `${message} Czego brakuje: ${text || MISSION_ERRORS.lines}`
          : `${message} (Szczegóły: ${text || `HTTP ${response.status}`}.)`);
        return;
      }
      // Ponowne sprawdzenie sekcji i źródeł w przeglądarce, zanim cokolwiek pokażemy.
      const shape = missionResponseSchema.safeParse(body);
      const checked = shape.success ? parseMissionResult(mission.layout, shape.data.result, shape.data.sources.length) : null;
      if (!shape.success || !checked?.success) { setError(MISSION_ERRORS.invalid_output); return; }
      const { run: savedRun, saveError } = shape.data;
      setReport({ result: checked.data, sources: shape.data.sources, completedAt: shape.data.completedAt, saved: Boolean(savedRun), saveError });
      // Nowe wykonanie na górze listy (najwyżej 5).
      if (savedRun) setRuns(current => ({ ...current, [mission.id]: [savedRun, ...(current[mission.id] ?? [])].slice(0, 5) }));
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
      {mission.about && <MissionAbout about={mission.about} />}
      <form onSubmit={run}>
        {mission.fields.map(field => {
          const value = values[field.name] ?? "";
          return <div key={field.name} className="mission-field">
            <label htmlFor={`mission-${field.name}`}>{field.label}</label>
            {field.multiline
              ? <textarea id={`mission-${field.name}`} value={value} maxLength={field.maxLength} placeholder={field.placeholder}
                rows={12} required disabled={busy || leaving}
                onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setError(""); }} />
              : <input id={`mission-${field.name}`} value={value} maxLength={field.maxLength} placeholder={field.placeholder}
              required disabled={busy || leaving}
              onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setError(""); }} />}
            <p className="status">{field.hint ? `${field.hint} ` : ""}{value.length}/{field.maxLength} znaków
              {mission.layout.type === "comparison" && field.name === mission.layout.criteriaField
                ? ` · kryteriów: ${parseCriteria(value).length}` : ""}
              {field.multiline ? ` · linii: ${value.split("\n").filter(line => line.trim()).length}` : ""}</p>
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
        {runLoadError && !report && <p className="error" role="alert">Nie udało się wczytać zapisanego wyniku. Odśwież stronę.</p>}
        {viewing && report && <div className="saved-run-banner">
          <p>Zapisany wynik z <strong>{formatCompletedAt(viewing.createdAt)}</strong>.</p>
          <details><summary>Dane wejściowe tego wykonania</summary><pre className="saved-run-input">{viewing.input}</pre></details>
          <Link href="/misje">Nowe wykonanie</Link>
        </div>}
        {report && <MissionReport mission={mission} report={report} />}
      </div>
      {mission.saveRuns && <RecentRuns runs={runs[mission.id] ?? null} openedId={viewing?.id} />}
    </section>}
  </main>;
}
