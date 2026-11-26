import { z } from "zod";

// Wspólne dla serwera i przeglądarki: kształt misji bez instrukcji dla modelu,
// budowanie schematów wejścia i wyniku oraz komunikaty błędów.
// Same misje (z instrukcjami) są zdefiniowane w jednym miejscu: lib/missions.ts.

export type MissionField = {
  name: string;
  label: string;
  maxLength: number;
  placeholder?: string;
  hint?: string;
};

// Sekcja wyniku: "text" = akapit, "list" = punkty (min–max). Źródła dokłada serwer.
// cite: każdy punkt kończy się numerem źródła, np. „… [2]”, z listy ponumerowanych źródeł.
// needsSources: gdy wyszukiwanie nic nie zwróciło, sekcja może (a przy cite musi) być pusta.
export type MissionSection =
  | { key: string; title: string; kind: "text"; hint: string }
  | { key: string; title: string; kind: "list"; min: number; max: number; hint: string; cite?: boolean; needsSources?: boolean };

// Układ wyniku misji:
// - "sections": sekcje tekstu i punktów w podanej kolejności (np. Raport),
// - "comparison": tabela firmy × kryteria, rekomendacja i źródła (np. Porównanie trzech firm).
export type MissionLayout =
  | { type: "sections"; sections: MissionSection[] }
  | { type: "comparison"; companyFields: string[]; criteriaField: string; minCriteria: number; maxCriteria: number };

export type PublicMission = {
  id: string;
  name: string;
  description: string;
  fields: MissionField[];
  layout: MissionLayout;
};

export const MISSION_TIME_LIMIT_MS = 60_000;
const MAX_TEXT_CHARS = 2_000;
const MAX_POINT_CHARS = 600;
export const MAX_CELL_CHARS = 300;
export const NO_DATA = "brak danych";

// Wartości pól formularza: każde pole wymagane, przycięte, najwyżej maxLength znaków.
export function missionInputSchema(fields: MissionField[]) {
  return z.strictObject(Object.fromEntries(fields.map(field =>
    [field.name, z.string().trim().min(1).max(field.maxLength)])));
}

// Kryteria po przecinku: bez pustych i bez powtórzeń (wielkość liter bez znaczenia).
export function parseCriteria(text: string): string[] {
  const seen = new Set<string>();
  const criteria: string[] = [];
  for (const part of text.split(",").map(item => item.trim().replace(/\s+/g, " ")).filter(Boolean)) {
    const key = part.toLocaleLowerCase("pl-PL");
    if (seen.has(key)) continue;
    seen.add(key);
    criteria.push(part);
  }
  return criteria;
}

// Dodatkowe sprawdzenie wejścia zależne od układu (serwer i przeglądarka liczą tak samo).
export function layoutInputError(layout: MissionLayout, input: Record<string, string>): MissionErrorCode | null {
  if (layout.type !== "comparison") return null;
  const count = parseCriteria(input[layout.criteriaField] ?? "").length;
  if (count < layout.minCriteria || count > layout.maxCriteria) return "criteria";
  const names = layout.companyFields.map(name => (input[name] ?? "").trim().toLocaleLowerCase("pl-PL"));
  if (new Set(names).size !== names.length) return "duplicates";
  return null;
}

// --- Układ "sections" ---

// Schemat dla modelu (JSON Schema w trybie strict): tylko proste typy, bez ograniczeń długości.
export function missionModelSchema(sections: MissionSection[]) {
  return z.strictObject(Object.fromEntries(sections.map(section => [section.key,
    section.kind === "text" ? z.string().describe(section.hint) : z.array(z.string()).describe(section.hint)])));
}

// Numery źródeł na końcu punktu, np. „… [1][3]” albo „… [2, 4]” → [1, 3] / [2, 4]. Brak = [].
const CITATION_END = /(?:\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\])+\s*\.?$/;
export function citedNumbers(point: string): number[] {
  const tail = point.match(CITATION_END)?.[0] ?? "";
  return [...tail.matchAll(/\d+/g)].map(match => Number(match[0]));
}
// Punkt z numerami, które wszystkie istnieją na liście źródeł 1..sourceCount.
export const hasValidCitation = (point: string, sourceCount: number) => {
  const numbers = citedNumbers(point);
  return numbers.length > 0 && numbers.every(number => number >= 1 && number <= sourceCount);
};

// Pełne sprawdzenie wyniku na serwerze i ponownie w przeglądarce: niepuste teksty,
// liczba punktów w podanym zakresie, rozsądne długości, numery źródeł z listy.
export function missionResultSchema(sections: MissionSection[], sourceCount: number) {
  return missionModelSchema(sections).superRefine((result, context) => {
    for (const section of sections) {
      const value = result[section.key];
      if (section.kind === "text") {
        if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT_CHARS) {
          context.addIssue({ code: "custom", path: [section.key], message: `Sekcja „${section.title}” jest pusta lub za długa.` });
        }
        continue;
      }
      const noSources = sourceCount === 0 && section.needsSources;
      const min = noSources ? 0 : section.min;
      const max = noSources && section.cite ? 0 : section.max;
      if (!Array.isArray(value) || value.length < min || value.length > max ||
        value.some(point => !point.trim() || point.length > MAX_POINT_CHARS)) {
        context.addIssue({ code: "custom", path: [section.key], message: `Sekcja „${section.title}” musi mieć ${min}–${max} punktów.` });
      } else if (section.cite && value.some(point => !hasValidCitation(point, sourceCount))) {
        context.addIssue({ code: "custom", path: [section.key], message: `Każdy punkt sekcji „${section.title}” musi kończyć się numerem źródła z listy.` });
      }
    }
  });
}

// --- Układ "comparison" ---

// Komórka tabeli: wartość i skąd pochodzi. source/host są ustawione tylko wtedy, gdy serwer
// potwierdził źródło wśród stron zwróconych przez wyszukiwanie dla tej firmy.
// independent: true = niezależny serwis (np. Trustpilot), false = strona lub dane samej firmy.
export const comparisonCellSchema = z.strictObject({
  value: z.string().min(1).max(MAX_CELL_CHARS),
  source: z.string().max(100).nullable(),
  host: z.string().max(253).nullable(),
  independent: z.boolean().nullable(),
});
export type ComparisonCell = z.infer<typeof comparisonCellSchema>;

// Podpis źródła komórki, np. „Trustpilot” albo „allegro.pl, dane firmy”.
export function sourceLabel(item: ComparisonCell) {
  if (!item.source) return "źródło nieustalone";
  return item.independent === false ? `${item.source}, dane firmy` : item.source;
}

// Gotowa tabela, którą serwer składa z pól sprawdzonych na serwerze (nie z tekstu modelu).
// cells[i][j] = ocena firmy j według kryterium i. mixedSources[i] = true, gdy w wierszu i
// wartości pochodzą z różnych serwisów albo część z nich to dane samych firm.
export const comparisonResultSchema = z.strictObject({
  companies: z.array(z.string().min(1)).min(2).max(5),
  criteria: z.array(z.string().min(1)).min(1).max(10),
  cells: z.array(z.array(comparisonCellSchema)),
  mixedSources: z.array(z.boolean()),
  // company + condition: „{company} — najlepszy wybór, jeśli zależy Ci na {condition}.”; bez company: brak podstaw.
  recommendation: z.strictObject({
    company: z.string().nullable(), condition: z.string().max(200).nullable(), reason: z.string().min(1).max(400),
  }),
  notes: z.array(z.string()).max(12),
}).refine(result => result.cells.length === result.criteria.length && result.mixedSources.length === result.criteria.length &&
  result.cells.every(row => row.length === result.companies.length), { message: "Tabela ma złe wymiary." })
  .refine(result => result.recommendation.company === null || result.companies.includes(result.recommendation.company),
    { message: "Rekomendacja wskazuje firmę spoza porównania." })
  .refine(result => (result.recommendation.company === null) === (result.recommendation.condition === null),
    { message: "Rekomendacja musi mieć warunek." });
export type ComparisonResult = z.infer<typeof comparisonResultSchema>;

// --- Odpowiedź endpointu ---

export const missionSourceSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
  // Przy porównaniu: której firmy dotyczyło wyszukiwanie.
  group: z.string().optional(),
});
export type MissionSource = z.infer<typeof missionSourceSchema>;

export const missionResponseSchema = z.strictObject({
  result: z.unknown(),
  // Wyłącznie strony zwrócone przez wyszukiwanie (url_citation od OpenRoutera), nie adresy z tekstu modelu.
  sources: z.array(missionSourceSchema).max(30),
  // Kiedy serwer zakończył misję (ISO 8601); strona pokazuje to pod wynikiem.
  completedAt: z.iso.datetime(),
});

// Sprawdza wynik zgodnie z układem misji (przeglądarka robi to ponownie przed wyświetleniem).
export function parseMissionResult(layout: MissionLayout, result: unknown, sourceCount: number) {
  return layout.type === "sections"
    ? missionResultSchema(layout.sections, sourceCount).safeParse(result)
    : comparisonResultSchema.safeParse(result);
}

// Data i godzina wykonania misji w Polsce, np. „26 listopada 2026 14:05”.
export function formatCompletedAt(iso: string) {
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(new Date(iso));
}

export const MISSION_ERRORS = {
  unknown: "Nie ma takiej misji. Odśwież stronę i wybierz misję z listy.",
  input: "Uzupełnij pola formularza (sprawdź limit znaków przy każdym polu).",
  criteria: "Podaj od 2 do 5 różnych kryteriów oddzielonych przecinkami, np. cena, opinie klientów, dostępność.",
  duplicates: "Podaj trzy różne firmy lub produkty.",
  configuration: "Brak konfiguracji modelu na serwerze (OPENROUTER_API_KEY i OPENROUTER_MODEL). Poproś administratora o uzupełnienie.",
  unsupported: "Ustawiony model nie obsługuje odpowiedzi w ustalonym formacie JSON. Misja nie została uruchomiona. Poproś administratora o zmianę modelu.",
  capability: "Nie udało się sprawdzić, czy model obsługuje odpowiedzi w formacie JSON. Misja nie została uruchomiona. Spróbuj ponownie za chwilę.",
  invalid_output: "Agent zwrócił wynik niezgodny z wymaganym układem. Nic nie zostało pokazane. Spróbuj uruchomić misję ponownie.",
  refused: "Model odmówił wykonania misji. Spróbuj inaczej sformułować dane.",
  timeout: "Misja trwała dłużej niż minutę i została przerwana. Spróbuj ponownie albo zawęź dane.",
  interrupted: "Misja została przerwana albo odpowiedź nie została ukończona. Spróbuj ponownie.",
  provider: "Błąd dostawcy AI lub wyszukiwarki. Misja się nie udała. Spróbuj ponownie za chwilę.",
} as const;

export type MissionErrorCode = keyof typeof MISSION_ERRORS;

export function isMissionErrorCode(value: unknown): value is MissionErrorCode {
  return typeof value === "string" && Object.hasOwn(MISSION_ERRORS, value);
}
