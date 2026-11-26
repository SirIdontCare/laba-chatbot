import { z } from "zod";

// Wspólne dla serwera i przeglądarki: kształt misji bez instrukcji dla modelu,
// budowanie schematów wejścia i wyniku oraz komunikaty błędów.
// Same misje (z instrukcjami) są zdefiniowane w jednym miejscu: lib/missions.ts.

export type MissionField = {
  name: string;
  label: string;
  maxLength: number;
  placeholder?: string;
};

// Sekcja wyniku: "text" = akapit, "list" = punkty (min–max). Źródła dokłada serwer.
export type MissionSection =
  | { key: string; title: string; kind: "text"; hint: string }
  | { key: string; title: string; kind: "list"; min: number; max: number; hint: string };

export type PublicMission = {
  id: string;
  name: string;
  description: string;
  fields: MissionField[];
  sections: MissionSection[];
};

export const MISSION_TIME_LIMIT_MS = 60_000;
const MAX_TEXT_CHARS = 2_000;
const MAX_POINT_CHARS = 600;

// Wartości pól formularza: każde pole wymagane, przycięte, najwyżej maxLength znaków.
export function missionInputSchema(fields: MissionField[]) {
  return z.strictObject(Object.fromEntries(fields.map(field =>
    [field.name, z.string().trim().min(1).max(field.maxLength)])));
}

// Schemat dla modelu (JSON Schema w trybie strict): tylko proste typy, bez ograniczeń długości.
export function missionModelSchema(sections: MissionSection[]) {
  return z.strictObject(Object.fromEntries(sections.map(section => [section.key,
    section.kind === "text" ? z.string().describe(section.hint) : z.array(z.string()).describe(section.hint)])));
}

// Pełne sprawdzenie wyniku na serwerze i ponownie w przeglądarce: niepuste teksty,
// liczba punktów w podanym zakresie, rozsądne długości.
export function missionResultSchema(sections: MissionSection[]) {
  return missionModelSchema(sections).superRefine((result, context) => {
    for (const section of sections) {
      const value = result[section.key];
      if (section.kind === "text") {
        if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT_CHARS) {
          context.addIssue({ code: "custom", path: [section.key], message: `Sekcja „${section.title}” jest pusta lub za długa.` });
        }
      } else if (!Array.isArray(value) || value.length < section.min || value.length > section.max ||
        value.some(point => !point.trim() || point.length > MAX_POINT_CHARS)) {
        context.addIssue({ code: "custom", path: [section.key], message: `Sekcja „${section.title}” musi mieć ${section.min}–${section.max} punktów.` });
      }
    }
  });
}

export const missionSourceSchema = z.strictObject({ url: z.url({ protocol: /^https?$/ }), title: z.string() });
export type MissionSource = z.infer<typeof missionSourceSchema>;

export const missionResponseSchema = z.strictObject({
  result: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  // Wyłącznie strony zwrócone przez wyszukiwanie (url_citation od OpenRoutera), nie adresy z tekstu modelu.
  sources: z.array(missionSourceSchema).max(20),
});

export const MISSION_ERRORS = {
  unknown: "Nie ma takiej misji. Odśwież stronę i wybierz misję z listy.",
  input: "Uzupełnij pola formularza (sprawdź limit znaków przy każdym polu).",
  configuration: "Brak konfiguracji modelu na serwerze (OPENROUTER_API_KEY i OPENROUTER_MODEL). Poproś administratora o uzupełnienie.",
  unsupported: "Ustawiony model nie obsługuje odpowiedzi w ustalonym formacie JSON. Misja nie została uruchomiona. Poproś administratora o zmianę modelu.",
  capability: "Nie udało się sprawdzić, czy model obsługuje odpowiedzi w formacie JSON. Misja nie została uruchomiona. Spróbuj ponownie za chwilę.",
  invalid_output: "Agent zwrócił raport niezgodny z wymaganym układem sekcji. Nic nie zostało pokazane. Spróbuj uruchomić misję ponownie.",
  refused: "Model odmówił wykonania misji. Spróbuj inaczej sformułować temat.",
  timeout: "Misja trwała dłużej niż minutę i została przerwana. Spróbuj ponownie albo zawęź temat.",
  interrupted: "Misja została przerwana albo odpowiedź nie została ukończona. Spróbuj ponownie.",
  provider: "Błąd dostawcy AI lub wyszukiwarki. Misja się nie udała. Spróbuj ponownie za chwilę.",
} as const;

export type MissionErrorCode = keyof typeof MISSION_ERRORS;

export function isMissionErrorCode(value: unknown): value is MissionErrorCode {
  return typeof value === "string" && Object.hasOwn(MISSION_ERRORS, value);
}
