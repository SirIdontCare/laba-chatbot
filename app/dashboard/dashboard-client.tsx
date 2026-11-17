"use client";
import { useState, useRef, useEffect, type FormEvent } from 'react';
import Link from 'next/link';
import ThemeToggle from '../theme-toggle';
import type { TravelResult } from '../../lib/travel-dashboard';
export default function DashboardClient() {
  const [compare, setCompare] = useState(false);
  const [secondCity, setSecondCity] = useState('');
  const [city, setCity] = useState('');
  const [date, setDate] = useState('');
  const [result, setResult] = useState<{ cities: TravelResult[]; summary: string }>();
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function load(event?: FormEvent) {
    event?.preventDefault();
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setAttempted(true); setBusy(true); setError(''); setResult(undefined);
    try {
      const response = await fetch('/api/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: city.trim(), date, ...(compare ? { secondCity: secondCity.trim() } : {}) }), signal: controller.signal });
      if (response.status === 401) { window.location.replace('/'); return; }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setResult({ cities: body.cities ?? [body], summary: body.summary });
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Nie udało się pobrać danych.'); }
    finally { active.current = null; setBusy(false); }
  }
  return <main className={`chat dashboard ${compare ? "dashboard--compare" : ""}`}>
    <header className="chat-header"><div><p className="eyebrow">TWOJA PRZESTRZEŃ PODRÓŻY</p><h1>Asystent podróży</h1><p className="header-description">Pięć źródeł. Jeden plan na wyjazd.</p></div><div className="header-actions"><Link href="/">← Wróć do czatu</Link><ThemeToggle /></div></header>
    <nav className="mode-switch" aria-label="Tryb podróży">{[false, true].map((value) => <button key={String(value)} type="button" aria-pressed={compare === value} disabled={busy} onClick={() => { setCompare(value); setResult(undefined); setAttempted(false); }}>{value ? 'Porównaj' : 'Jedno miasto'}</button>)}</nav>
    <form className="travel-form" onSubmit={load}>
      <label>Dokąd jedziesz?<input value={city} onChange={(e) => {setCity(e.target.value); setResult(undefined); setAttempted(false);}} required minLength={2} maxLength={120} placeholder="Miasto, np. Lizbona, Portugalia" disabled={busy} /></label>
      {compare && <label>Drugie miasto<input value={secondCity} onChange={(e) => { setSecondCity(e.target.value); setResult(undefined); setAttempted(false); }} required minLength={2} maxLength={120} placeholder="Np. Lizbona, Portugalia" disabled={busy} /></label>}
      <label>Kiedy?<input type="date" value={date} onChange={(e) => {setDate(e.target.value); setResult(undefined); setAttempted(false);}} required disabled={busy} /></label>
      <button disabled={busy}>{busy ? 'Sprawdzam…' : compare ? 'Porównaj' : 'Sprawdź'}</button>
      {attempted && <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>Odśwież</button>}
    </form>
    <p className="image-hint">Prognoza obejmuje dziś i najbliższe 15 dni. Dopisz kraj lub region, jeśli nazwa miasta jest niejednoznaczna.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p role="status" className="status">Pobieram dane i przygotowuję podsumowanie…</p>}
    {attempted && !result && <div className="travel-grid" aria-busy={busy}>{(compare ? ['Miasto 1', 'Miasto 2'] : ['Miasto']).flatMap((name) => ['Pogoda', 'Waluty', 'Święta', 'Wikipedia', 'Czas'].map((label) => `${name} · ${label}`)).map((title) => <article className="travel-card" key={title}>
      <h2>{title}</h2><span className="card-status" role="status">{busy ? 'Ładuję…' : 'Brak danych'}</span>
      {!busy && <p>Brak danych — spróbuj odświeżyć</p>}
    </article>)}</div>}
    {result && <><div className="destination-columns">{result.cities.map((cityResult, cityIndex) => <section key={cityIndex} className="destination-column"><h2>{cityResult.destination} · {cityResult.date}</h2><div className="travel-grid">{cityResult.cards.map((card) => <article key={card.title} className="travel-card">
      <h2>{card.title}</h2><span className="card-status" role="status">{card.error ? 'Brak danych' : 'OK'}</span><p className={card.error ? 'error' : 'travel-value'}>{card.value}</p>
      {card.error && card.detail && <p className="status">{card.detail}</p>}
      {card.url && <a href={card.url} target="_blank" rel="noopener noreferrer">Otwórz źródło ↗</a>}
      <small className="model-id">{card.source} · {card.error ? 'Próba pobrania' : 'Pobrano'}: <time dateTime={card.fetchedAt}>{new Date(card.fetchedAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}</time> (Warszawa)</small>
    </article>)}</div></section>)}</div><section className="travel-summary"><p className="eyebrow">{compare ? 'REKOMENDACJA AGENTA' : 'PODSUMOWANIE AGENTA'}</p><p>{result.summary}</p></section></>}
  </main>;
}
