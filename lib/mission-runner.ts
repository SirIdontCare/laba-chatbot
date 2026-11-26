import "server-only";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText, isStepCount, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { AnalysisError, hasRefusal, requireStructuredOutput } from "./analyze-message";
import { warsawTime } from "./chat-tools";
import { webSearchTool } from "./model";
import { AGENT_STEP_LIMIT } from "./tool-catalog";
import type { Mission } from "./missions";
import {
  hasValidCitation, MAX_CELL_CHARS, MISSION_TIME_LIMIT_MS, missionModelSchema, missionResultSchema, missionSourceSchema, NO_DATA,
  parseCriteria, comparisonResultSchema, sourceLabel, type ComparisonCell, type ComparisonResult, type MissionErrorCode, type MissionSection, type MissionSource,
} from "./mission-schema";

export type MissionOutcome =
  | { ok: true; result: unknown; sources: MissionSource[] }
  | { ok: false; code: MissionErrorCode; status: number };

type OpenRouter = ReturnType<typeof createOpenRouter>;
type Context = { openrouter: OpenRouter; model: string; signal: AbortSignal; timeout: AbortSignal };
class MissionFailure extends Error {
  constructor(readonly code: MissionErrorCode, readonly status: number) { super(code); }
}

const fail = (code: MissionErrorCode, status: number): MissionOutcome => ({ ok: false, code, status });

function today() {
  const now = warsawTime();
  return `${now.data} (${now.dzienTygodnia}, ${now.strefa})`;
}

// Źródła wyłącznie z odpowiedzi wyszukiwarki (części "source" od OpenRoutera, ze wszystkich kroków),
// bez duplikatów i tylko http/https. Adresy wpisane przez model w tekst nie są tu brane pod uwagę.
function searchSources(steps: { sources: readonly { sourceType: string; url?: string; title?: string }[] }[],
  group?: string, limit = 20): MissionSource[] {
  const seen = new Set<string>();
  const sources: MissionSource[] = [];
  for (const source of steps.flatMap(step => step.sources)) {
    if (source.sourceType !== "url" || !source.url || seen.has(source.url)) continue;
    let hostname: string;
    try { hostname = new URL(source.url).hostname; } catch { continue; }
    const parsed = missionSourceSchema.safeParse({ url: source.url, title: source.title?.trim() || hostname, ...(group ? { group } : {}) });
    if (!parsed.success) continue;
    seen.add(source.url);
    sources.push(parsed.data);
    if (sources.length >= limit) break;
  }
  return sources;
}

// Wynik w ustalonych polach: ten sam kształt zapytania co „Analiza JSON” (bez narzędzi).
async function structured<T>({ openrouter, model, signal }: Context, schema: z.ZodType<T>, name: string,
  instructions: string, content: string): Promise<unknown> {
  let refused = false;
  const result = await generateText({
    model: openrouter.chat(model, { structuredOutputs: { strict: true }, provider: { require_parameters: true } }),
    output: Output.object({ schema, name }),
    instructions,
    messages: [{ role: "user", content }],
    abortSignal: signal,
    maxRetries: 0,
    include: { responseBody: true },
    onStepEnd: ({ finishReason, response }) => {
      if (finishReason === "content-filter" || hasRefusal(response.body)) refused = true;
    },
  });
  if (refused) throw new MissionFailure("refused", 502);
  if (result.finishReason !== "stop") throw new MissionFailure("interrupted", 502);
  return result.output;
}

// --- Krok 1 obu układów: wyszukiwanie w internecie i notatki ze źródłami ---

type Research = { subject: string; notes: string; sources: MissionSource[]; failed: boolean };

async function research(mission: Mission, subject: string, input: Record<string, string>, ctx: Context,
  { group, limit }: { group?: string; limit: number }): Promise<Research> {
  try {
    // Jak w czacie: wyszukiwanie w internecie i zwykły tekst, bez wymagania structured output.
    const result = await generateText({
      model: ctx.openrouter(ctx.model, { parallelToolCalls: false }),
      tools: { web_search: webSearchTool(ctx.openrouter, { maxResults: 5 }) },
      instructions: `${mission.research.instructions}\n\nBieżąca data: ${today()}.`,
      messages: [{ role: "user", content: mission.research.prompt(subject, input) }],
      // Ten sam limit kroków co w czacie; do tego minuta na całą misję.
      stopWhen: isStepCount(AGENT_STEP_LIMIT),
      abortSignal: ctx.signal,
      maxRetries: 0,
    });
    return { subject, notes: result.text.trim().slice(0, 6_000), sources: searchSources(result.steps, group, limit), failed: false };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (APICallError.isInstance(error)) console.error(`[misje] wyszukiwanie: HTTP ${error.statusCode ?? "brak"}`);
    return { subject, notes: "", sources: [], failed: true };
  }
}

// --- Układ "sections" (Raport): krok 1 wyszukiwanie, krok 2 ułożenie w pola z numerami źródeł ---

async function runSections(mission: Mission, sections: MissionSection[], input: Record<string, string>, ctx: Context): Promise<MissionOutcome> {
  const subject = input[mission.fields[0].name];
  const found = await research(mission, subject, input, ctx, { limit: 12 });
  if (found.failed) return fail("provider", 502);
  const sources = found.sources;

  // Wyszukiwanie nic nie zwróciło: raport mówi to wprost, bez wywoływania modelu (nie ma czego cytować).
  if (!sources.length) {
    const result = Object.fromEntries(sections.map(section => [section.key, section.kind === "text"
      ? `Wyszukiwanie w internecie nie zwróciło żadnych stron na temat „${subject}”, więc nie ma podstaw do raportu. ` +
        "Nie podajemy faktów bez źródeł. Spróbuj inaczej sformułować temat."
      : section.needsSources ? []
        : ["Wyszukiwanie nie zwróciło żadnych stron, dlatego nie udało się ustalić żadnych faktów na ten temat."]]));
    const validated = missionResultSchema(sections, 0).safeParse(result);
    return validated.success ? { ok: true, result: validated.data, sources } : fail("invalid_output", 502);
  }

  // Krok 2: notatki i ponumerowana lista źródeł → ustalone pola (bez narzędzi).
  const numbered = sources.map((source, i) => `[${i + 1}] ${source.title} (${new URL(source.url).hostname})`).join("\n");
  const output = await structured(ctx, missionModelSchema(sections), `misja_${mission.id}`,
    `${mission.instructions}\n\nBieżąca data: ${today()}.`,
    `Temat: ${subject}\n\n<notatki>\n${found.notes || "Brak notatek."}\n</notatki>\n\n<zrodla>\n${numbered}\n</zrodla>`);
  const parsed = missionModelSchema(sections).safeParse(output);
  if (!parsed.success) return fail("invalid_output", 502);
  // Fakt z numerem spoza listy źródeł nie jest pokazywany (nie ma go czym potwierdzić).
  const repaired = Object.fromEntries(sections.map(section => {
    const value = parsed.data[section.key];
    return [section.key, section.kind === "list" && section.cite && Array.isArray(value)
      ? value.filter(point => hasValidCitation(point, sources.length)) : value];
  }));
  // Pełne sprawdzenie sekcji na serwerze (kolejność wynika z definicji misji).
  const validated = missionResultSchema(sections, sources.length).safeParse(repaired);
  if (!validated.success) return fail("invalid_output", 502);
  return { ok: true, result: validated.data, sources };
}

// --- Układ "comparison": krok 1 wyszukiwanie osobno dla każdej firmy, krok 2 tabela w polach,
// krok 3 rekomendacja z gotowej tabeli ---

// Komórki, które oznaczają brak informacji, zamieniamy na jednolite „brak danych”.
const PLACEHOLDERS = new Set(["0", "-", "–", "—", "?", "n/a", "na", "brak", "nieznane", "nie wiadomo", "unknown", "none", "null", "b.d.", "bd"]);
function cellValue(value: string) {
  const trimmed = value.trim();
  return !trimmed || PLACEHOLDERS.has(trimmed.toLocaleLowerCase("pl-PL")) ? NO_DATA : trimmed.slice(0, MAX_CELL_CHARS);
}

const EMPTY_CELL: ComparisonCell = { value: NO_DATA, source: null, host: null, independent: null };
const normalize = (text: string) => text.toLocaleLowerCase("pl-PL").normalize("NFD").replace(/[^a-z0-9]/g, "");
// Słowa, które nie wskazują konkretnego serwisu.
const GENERIC_WORDS = new Set(["dane", "firmy", "firma", "strona", "oficjalna", "serwis", "opinie", "www", "com", "pl", "niezalezne"]);
// Domena bez subdomen (pl.trustpilot.com i trustpilot.com to ten sam serwis).
const siteOf = (host: string) => host.replace(/^www\./, "").split(".").slice(-2).join(".");

// Źródło komórki potwierdzamy wśród stron zwróconych przez wyszukiwanie dla tej firmy
// (nazwa serwisu z modelu musi pasować do adresu lub tytułu strony). Bez potwierdzenia: brak źródła.
function confirmSource(name: string, sources: MissionSource[]): { source: string; host: string } | null {
  const words = name.split(/[\s,.;:()/]+/).map(normalize).filter(word => word.length >= 3 && !GENERIC_WORDS.has(word));
  if (!words.length) return null;
  for (const source of sources) {
    const host = new URL(source.url).hostname;
    const haystack = normalize(host) + " " + normalize(source.title);
    if (words.some(word => haystack.includes(word))) return { source: name.trim().slice(0, 100), host: siteOf(host) };
  }
  return null;
}

function buildCell(raw: { wartosc: string; zrodlo: string; niezalezne: boolean }, sources: MissionSource[]): ComparisonCell {
  const value = cellValue(raw.wartosc);
  if (value === NO_DATA) return EMPTY_CELL;
  const confirmed = confirmSource(raw.zrodlo, sources);
  return { value, source: confirmed?.source ?? null, host: confirmed?.host ?? null, independent: confirmed ? raw.niezalezne : null };
}

function comparisonSchema(companies: string[], criteria: string[]) {
  const companyKey = (index: number) => `firma_${index + 1}`;
  const criterionKey = (index: number) => `kryterium_${index + 1}`;
  return {
    companyKey, criterionKey,
    schema: z.strictObject({
      tabela: z.strictObject(Object.fromEntries(companies.map((company, i) => [companyKey(i),
        z.strictObject(Object.fromEntries(criteria.map((criterion, j) => [criterionKey(j),
          z.strictObject({
            wartosc: z.string().describe(`„${company}” według kryterium „${criterion}”. Gdy brak informacji w notatkach: „${NO_DATA}”.`),
            zrodlo: z.string().describe("Nazwa serwisu, z którego pochodzi wartość, jak w notatkach; pusty tekst przy braku danych."),
            niezalezne: z.boolean().describe("true = niezależny serwis z opiniami lub media; false = strona lub dane samej firmy."),
          })])))
          .describe(`Oceny firmy „${company}”.`)]))),
    }),
  };
}

function recommendationSchema(companies: string[]) {
  return z.strictObject({
    rekomendacja: z.enum([...companies, "brak"]).describe("Polecana firma (dokładnie jak w tabeli) albo „brak”."),
    warunek: z.string().describe("Dokończenie zdania „najlepszy wybór, jeśli zależy Ci na…”; pusty tekst przy „brak”."),
    uzasadnienie: z.string().describe("Jedno zdanie odwołujące się do wartości z tabeli."),
  });
}

// Powyżej tego udziału komórek „brak danych” nie ma podstaw do rekomendacji.
export const MAX_NO_DATA_SHARE = 0.5;

const noDataCount = (cells: ComparisonCell[]) => cells.filter(item => item.value === NO_DATA).length;

async function recommend(mission: Mission, companies: string[], criteria: string[], cells: ComparisonCell[][],
  mixedSources: boolean[], ctx: Context): Promise<ComparisonResult["recommendation"]> {
  const all = cells.flat();
  const missing = noDataCount(all);
  // Za dużo braków w tabeli: nie ma podstaw do rekomendacji (bez pytania modelu).
  if (missing / all.length > MAX_NO_DATA_SHARE) {
    return { company: null, condition: null,
      reason: `Nie ma podstaw do rekomendacji: ${missing} z ${all.length} komórek tabeli to „${NO_DATA}”.` };
  }
  const table = criteria.map((criterion, j) => ({
    kryterium: criterion,
    ...(mixedSources[j] ? { uwaga: "wartości z różnych źródeł, nie w pełni porównywalne" } : {}),
    wartosci: Object.fromEntries(companies.map((company, i) => [company,
      cells[j][i].value === NO_DATA ? NO_DATA : `${cells[j][i].value} (${sourceLabel(cells[j][i])})`])),
  }));
  const schema = recommendationSchema(companies);
  const parsed = schema.safeParse(await structured(ctx, schema, `misja_${mission.id}_rekomendacja`,
    mission.recommendation!.instructions, `<tabela>\n${JSON.stringify(table, null, 1)}\n</tabela>`));
  if (!parsed.success) throw new MissionFailure("invalid_output", 502);
  const { rekomendacja, warunek, uzasadnienie } = parsed.data;
  const index = companies.indexOf(rekomendacja);
  const condition = warunek.trim().replace(/^(najlepszy wybór,?\s*)?jeśli zależy ci na\s*/i, "").replace(/[.…]+$/, "").trim();
  const reason = uzasadnienie.trim().slice(0, 400);
  if (index < 0) {
    return { company: null, condition: null, reason: reason || "Tabela nie daje podstaw do wskazania najlepszej firmy." };
  }
  // Firma z przewagą „brak danych” w swojej kolumnie nie może być polecana.
  const column = cells.map(row => row[index]);
  if (noDataCount(column) / column.length > MAX_NO_DATA_SHARE || !condition || !reason) {
    return { company: null, condition: null,
      reason: `Nie ma podstaw do rekomendacji: dla „${companies[index]}” w tabeli brakuje zbyt wielu danych.` };
  }
  return { company: companies[index], condition: condition.slice(0, 200), reason };
}

async function runComparison(mission: Mission, input: Record<string, string>, ctx: Context): Promise<MissionOutcome> {
  if (mission.layout.type !== "comparison" || !mission.recommendation) return fail("unknown", 404);
  const companies = mission.layout.companyFields.map(name => input[name].trim());
  const criteria = parseCriteria(input[mission.layout.criteriaField]);

  // Krok 1: zebranie informacji ze źródłami, równolegle dla każdej firmy.
  const findings = await Promise.all(companies.map(company => research(mission, company, input, ctx, { group: company, limit: 8 })));
  if (findings.every(item => item.failed)) return fail("provider", 502);

  // Krok 2: ułożenie notatek w ustalone pola (bez narzędzi), sprawdzonych na serwerze.
  const { schema, companyKey, criterionKey } = comparisonSchema(companies, criteria);
  const notes = findings.map((item, i) => `<notatki firma="${companyKey(i)}" nazwa="${item.subject}">\n` +
    (item.sources.length ? item.notes || NO_DATA : "Wyszukiwanie nie zwróciło żadnych stron. Wszystkie kryteria: brak danych.") +
    `\nŹródła: ${item.sources.map(source => source.title).join("; ") || "brak"}\n</notatki>`).join("\n\n");
  const output = await structured(ctx, schema, `misja_${mission.id}`, mission.instructions,
    `Firmy: ${companies.map((company, i) => `${companyKey(i)} = „${company}”`).join(", ")}\n` +
    `Kryteria: ${criteria.map((criterion, j) => `${criterionKey(j)} = „${criterion}”`).join(", ")}\n\n${notes}`);
  const parsed = schema.safeParse(output);
  if (!parsed.success) return fail("invalid_output", 502);
  const { tabela } = parsed.data as {
    tabela: Record<string, Record<string, { wartosc: string; zrodlo: string; niezalezne: boolean }>>;
  };

  // Firma bez żadnego źródła z wyszukiwania ma w całej kolumnie „brak danych” (nie zgadujemy).
  const grounded = findings.map(item => item.sources.length > 0);
  const cells = criteria.map((_, j) => companies.map((_, i) =>
    grounded[i] ? buildCell(tabela[companyKey(i)][criterionKey(j)], findings[i].sources) : EMPTY_CELL));
  // Wiersz z różnymi serwisami albo z danymi samych firm obok niezależnych ocen nie jest w pełni porównywalny.
  const mixedSources = cells.map(row => {
    const filled = row.filter(item => item.value !== NO_DATA);
    if (filled.length < 2) return false;
    const sites = new Set(filled.map(item => item.host ?? "?"));
    return sites.size > 1 || sites.has("?") || new Set(filled.map(item => item.independent)).size > 1;
  });
  const mixedNotes = criteria.flatMap((criterion, j) => mixedSources[j]
    ? [`„${criterion}”: wartości pochodzą z różnych źródeł (${cells[j]
      .map((item, i) => ({ item, company: companies[i] })).filter(({ item }) => item.value !== NO_DATA)
      .map(({ item, company }) => `${company}: ${sourceLabel(item)}`).join("; ")}), więc nie są w pełni porównywalne.`]
    : []);
  // Krok 3: rekomendacja wyłącznie z gotowej tabeli (tej samej, którą widzi osoba).
  const recommendation = await recommend(mission, companies, criteria, cells, mixedSources, ctx);

  const result: ComparisonResult = {
    companies, criteria, cells, mixedSources,
    recommendation,
    notes: [...mixedNotes, ...findings.filter(item => !item.sources.length).map(item => item.failed
      ? `Nie udało się wyszukać informacji o „${item.subject}”, dlatego jej kolumna ma „${NO_DATA}”.`
      : `Wyszukiwanie nie zwróciło żadnych stron o „${item.subject}”, dlatego jej kolumna ma „${NO_DATA}”.`)],
  };
  const validated = comparisonResultSchema.safeParse(result);
  if (!validated.success) return fail("invalid_output", 502);
  return { ok: true, result: validated.data, sources: findings.flatMap(item => item.sources) };
}

export async function runMission(mission: Mission, input: Record<string, string>, signal: AbortSignal): Promise<MissionOutcome> {
  // Klucz i model są odczytywane wyłącznie na serwerze.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) return fail("configuration", 503);

  // Minuta na całą misję (wszystkie kroki razem).
  const timeout = AbortSignal.timeout(MISSION_TIME_LIMIT_MS);
  const ctx: Context = { openrouter: createOpenRouter({ apiKey }), model, signal: AbortSignal.any([signal, timeout]), timeout };
  try {
    await requireStructuredOutput(model, ctx.signal);
  } catch (error) {
    if (timeout.aborted) return fail("timeout", 504);
    if (signal.aborted) return fail("interrupted", 400);
    return fail(error instanceof AnalysisError && error.code === "unsupported" ? "unsupported" : "capability", 503);
  }

  try {
    return mission.layout.type === "sections"
      ? await runSections(mission, mission.layout.sections, input, ctx)
      : await runComparison(mission, input, ctx);
  } catch (error) {
    if (timeout.aborted) return fail("timeout", 504);
    if (signal.aborted) return fail("interrupted", 400);
    if (error instanceof MissionFailure) return fail(error.code, error.status);
    if (NoObjectGeneratedError.isInstance(error)) return fail("invalid_output", 502);
    // W logu tylko kod HTTP: bez treści zapytania, odpowiedzi dostawcy i sekretów.
    if (APICallError.isInstance(error)) console.error(`[misje] błąd dostawcy AI: HTTP ${error.statusCode ?? "brak"}`);
    return fail("provider", 502);
  }
}
