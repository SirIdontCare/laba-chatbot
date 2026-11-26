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
  MAX_CELL_CHARS, MISSION_TIME_LIMIT_MS, missionModelSchema, missionResultSchema, missionSourceSchema, NO_DATA,
  parseCriteria, comparisonResultSchema, type ComparisonResult, type MissionErrorCode, type MissionSection, type MissionSource,
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

// --- Układ "sections" (Raport): wyszukiwanie i wynik w polach w jednym wywołaniu ---

async function runSections(mission: Mission, sections: MissionSection[], input: Record<string, string>, ctx: Context): Promise<MissionOutcome> {
  let refused = false;
  const result = await generateText({
    model: ctx.openrouter.chat(ctx.model, { structuredOutputs: { strict: true }, provider: { require_parameters: true } }),
    tools: mission.webSearch ? { web_search: webSearchTool(ctx.openrouter, { maxResults: 5 }) } : undefined,
    output: Output.object({ schema: missionModelSchema(sections), name: `misja_${mission.id}` }),
    instructions: `${mission.instructions}\n\nBieżąca data: ${today()}.`,
    messages: [{ role: "user", content: mission.prompt(input) }],
    // Ten sam limit kroków co w czacie; do tego minuta na całą misję.
    stopWhen: isStepCount(AGENT_STEP_LIMIT),
    abortSignal: ctx.signal,
    maxRetries: 0,
    include: { responseBody: true },
    onStepEnd: ({ finishReason, response }) => {
      if (finishReason === "content-filter" || hasRefusal(response.body)) refused = true;
    },
  });
  if (refused) return fail("refused", 502);
  if (result.finishReason !== "stop") return fail("interrupted", 502);
  // Pełne sprawdzenie sekcji na serwerze (kolejność wynika z definicji misji).
  const validated = missionResultSchema(sections).safeParse(result.output);
  if (!validated.success) return fail("invalid_output", 502);
  return { ok: true, result: validated.data, sources: searchSources(result.steps) };
}

// --- Układ "comparison": krok 1 wyszukiwanie osobno dla każdej firmy, krok 2 ułożenie w pola ---

// Komórki, które oznaczają brak informacji, zamieniamy na jednolite „brak danych”.
const PLACEHOLDERS = new Set(["0", "-", "–", "—", "?", "n/a", "na", "brak", "nieznane", "nie wiadomo", "unknown", "none", "null", "b.d.", "bd"]);
function cell(value: string) {
  const trimmed = value.trim();
  return !trimmed || PLACEHOLDERS.has(trimmed.toLocaleLowerCase("pl-PL")) ? NO_DATA : trimmed.slice(0, MAX_CELL_CHARS);
}

type Research = { company: string; notes: string; sources: MissionSource[]; failed: boolean };

async function research(mission: Mission, company: string, criteria: string[], ctx: Context): Promise<Research> {
  try {
    // Jak w czacie: wyszukiwanie w internecie i zwykły tekst, bez wymagania structured output.
    const result = await generateText({
      model: ctx.openrouter(ctx.model, { parallelToolCalls: false }),
      tools: { web_search: webSearchTool(ctx.openrouter, { maxResults: 5 }) },
      instructions: `${mission.research!.instructions}\n\nBieżąca data: ${today()}.`,
      messages: [{ role: "user", content: mission.research!.prompt(company, criteria) }],
      stopWhen: isStepCount(AGENT_STEP_LIMIT),
      abortSignal: ctx.signal,
      maxRetries: 0,
    });
    return { company, notes: result.text.trim().slice(0, 6_000), sources: searchSources(result.steps, company, 8), failed: false };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (APICallError.isInstance(error)) console.error(`[misje] wyszukiwanie: HTTP ${error.statusCode ?? "brak"}`);
    return { company, notes: "", sources: [], failed: true };
  }
}

function comparisonSchema(companies: string[], criteria: string[]) {
  const companyKey = (index: number) => `firma_${index + 1}`;
  const criterionKey = (index: number) => `kryterium_${index + 1}`;
  return {
    companyKey, criterionKey,
    schema: z.strictObject({
      tabela: z.strictObject(Object.fromEntries(companies.map((company, i) => [companyKey(i),
        z.strictObject(Object.fromEntries(criteria.map((criterion, j) => [criterionKey(j),
          z.string().describe(`„${company}” według kryterium „${criterion}”. Gdy brak informacji w notatkach: „${NO_DATA}”.`)])))
          .describe(`Oceny firmy „${company}”.`)]))),
      rekomendacja: z.enum([...companies.map((_, i) => companyKey(i)), "brak"])
        .describe(`Polecana firma: ${companies.map((company, i) => `${companyKey(i)} = „${company}”`).join(", ")}; „brak”, gdy danych jest za mało.`),
      uzasadnienie: z.string().describe("Jedno zdanie uzasadnienia rekomendacji."),
    }),
  };
}

async function runComparison(mission: Mission, input: Record<string, string>, ctx: Context): Promise<MissionOutcome> {
  if (mission.layout.type !== "comparison" || !mission.research) return fail("unknown", 404);
  const companies = mission.layout.companyFields.map(name => input[name].trim());
  const criteria = parseCriteria(input[mission.layout.criteriaField]);

  // Krok 1: zebranie informacji ze źródłami, równolegle dla każdej firmy.
  const findings = await Promise.all(companies.map(company => research(mission, company, criteria, ctx)));
  if (findings.every(item => item.failed)) return fail("provider", 502);

  // Krok 2: ułożenie notatek w ustalone pola (bez narzędzi), sprawdzonych na serwerze.
  const { schema, companyKey, criterionKey } = comparisonSchema(companies, criteria);
  const notes = findings.map((item, i) => `<notatki firma="${companyKey(i)}" nazwa="${item.company}">\n` +
    (item.sources.length ? item.notes || NO_DATA : "Wyszukiwanie nie zwróciło żadnych stron. Wszystkie kryteria: brak danych.") +
    `\nŹródła: ${item.sources.map(source => source.title).join("; ") || "brak"}\n</notatki>`).join("\n\n");
  const output = await structured(ctx, schema, `misja_${mission.id}`, mission.instructions,
    `Firmy: ${companies.map((company, i) => `${companyKey(i)} = „${company}”`).join(", ")}\n` +
    `Kryteria: ${criteria.map((criterion, j) => `${criterionKey(j)} = „${criterion}”`).join(", ")}\n\n${notes}`);
  const parsed = schema.safeParse(output);
  if (!parsed.success) return fail("invalid_output", 502);
  const { tabela, rekomendacja, uzasadnienie } = parsed.data as {
    tabela: Record<string, Record<string, string>>; rekomendacja: string; uzasadnienie: string;
  };

  // Firma bez żadnego źródła z wyszukiwania ma w całej kolumnie „brak danych” (nie zgadujemy).
  const grounded = findings.map(item => item.sources.length > 0);
  const cells = criteria.map((_, j) => companies.map((_, i) =>
    grounded[i] ? cell(tabela[companyKey(i)][criterionKey(j)]) : NO_DATA));
  const recommendedIndex = companies.findIndex((_, i) => companyKey(i) === rekomendacja);
  const hasData = cells.some(row => row.some(value => value !== NO_DATA));
  const recommended = recommendedIndex >= 0 && grounded[recommendedIndex] && hasData ? companies[recommendedIndex] : null;
  const reason = recommended
    ? uzasadnienie.trim().slice(0, 400) || "Brak uzasadnienia."
    : rekomendacja === "brak" && uzasadnienie.trim()
      ? uzasadnienie.trim().slice(0, 400)
      : "Za mało danych z wyszukiwania, żeby wskazać rekomendację.";

  const result: ComparisonResult = {
    companies, criteria, cells,
    recommendation: { company: recommended, reason },
    notes: findings.filter(item => !item.sources.length).map(item => item.failed
      ? `Nie udało się wyszukać informacji o „${item.company}”, dlatego jej kolumna ma „${NO_DATA}”.`
      : `Wyszukiwanie nie zwróciło żadnych stron o „${item.company}”, dlatego jej kolumna ma „${NO_DATA}”.`),
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
