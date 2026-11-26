import { z } from "zod";

// Wspólne dla serwera i przeglądarki: limity, schemat wyniku i komunikaty błędów.
export const TRIAGE_MAX_EMAILS = 10;
export const TRIAGE_MAX_EMAIL_CHARS = 12_000;
export const TRIAGE_MAX_INPUT_CHARS = 130_000;
export const TRIAGE_SIGNATURE = "Zespół obsługi";

export const TRIAGE_CATEGORIES = ["oferta i ceny", "problem techniczny", "płatności", "reklamacja", "inne"] as const;
export const TRIAGE_PRIORITIES = ["wysoki", "średni", "niski"] as const;

// Schemat przekazywany modelowi jako JSON Schema (structured output): tylko proste typy
// i enum, bo tryb strict dostawców nie obsługuje wszystkich ograniczeń długości.
// strictObject odrzuca dodatkowe pola; enum przyjmuje wyłącznie podane wartości.
const triageFieldsSchema = z.strictObject({
  nadawca: z.string()
    .describe("Nadawca maila (imię, nazwisko lub adres). Gdy brak w treści: „nieznany nadawca”."),
  temat: z.string()
    .describe("Temat maila. Gdy brak w treści: krótki temat w kilku słowach na podstawie treści."),
  kategoria: z.enum(TRIAGE_CATEGORIES),
  priorytet: z.enum(TRIAGE_PRIORITIES),
  uzasadnienie: z.string().describe("Jedno zdanie po polsku: dlaczego taki priorytet."),
  szkic: z.string()
    .describe(`Szkic odpowiedzi po polsku: 3–5 zdań, uprzejmy, zakończony podpisem „${TRIAGE_SIGNATURE}”.`),
});

// Model podaje też tytuły dokumentów, z których korzysta szkic. Serwer zostawia tylko te,
// które naprawdę zwróciło wyszukiwanie w bazie wiedzy (pole sources karty).
export const triageModelSchema = triageFieldsSchema.extend({
  zrodla: z.array(z.string())
    .describe("Tytuły dokumentów z bazy wiedzy (dokładnie jak w polu tytul), z których korzysta szkic. Pusta lista, gdy żaden."),
});

const filled = (value: string, max: number) => value.trim().length > 0 && value.length <= max;

// Znacznik brakującej informacji w szkicu, np. [DO UZUPEŁNIENIA: cena pakietu dla 5 osób].
export const TODO_MARKER = /\[DO UZUPEŁNIENIA:[^\]]*\]/gu;

export const TRIAGE_PRIORITY_RANK = { wysoki: 0, średni: 1, niski: 2 } as const;

// Pełne sprawdzenie wyniku na serwerze (i ponownie w przeglądarce): pola niepuste,
// rozsądne długości i podpis na końcu szkicu. Refine nie trafia do JSON Schema dla modelu.
export const triageResultSchema = triageFieldsSchema
  .refine(r => filled(r.nadawca, 300), { path: ["nadawca"], message: "Brak nadawcy." })
  .refine(r => filled(r.temat, 300), { path: ["temat"], message: "Brak tematu." })
  .refine(r => filled(r.uzasadnienie, 400), { path: ["uzasadnienie"], message: "Brak uzasadnienia." })
  .refine(r => filled(r.szkic, 2_000) && r.szkic.trim().endsWith(TRIAGE_SIGNATURE), {
    path: ["szkic"], message: `Szkic musi kończyć się podpisem „${TRIAGE_SIGNATURE}”.`,
  });

export type TriageResult = z.infer<typeof triageResultSchema>;

export const triageRequestSchema = z.strictObject({
  text: z.string().max(TRIAGE_MAX_INPUT_CHARS),
});

export const TRIAGE_ERRORS = {
  input: "Wklej co najmniej jeden mail. Kilka maili oddziel linią zawierającą tylko trzy myślniki (---).",
  tooMany: `Naraz można posortować najwyżej ${TRIAGE_MAX_EMAILS} maili. Usuń nadmiarowe i spróbuj ponownie.`,
  tooLong: `Jeden z maili jest za długi (limit ${TRIAGE_MAX_EMAIL_CHARS.toLocaleString("pl-PL")} znaków). Skróć go i spróbuj ponownie.`,
  inputTooLong: "Wklejony tekst jest za długi. Podziel go na mniejsze części.",
  configuration: "Brak konfiguracji modelu na serwerze (OPENROUTER_API_KEY i OPENROUTER_MODEL). Poproś administratora o uzupełnienie.",
  unsupported: "Ustawiony model nie obsługuje odpowiedzi w ustalonym formacie JSON. Sortowanie nie zostało uruchomione. Poproś administratora o zmianę modelu.",
  capability: "Nie udało się sprawdzić, czy model obsługuje odpowiedzi w formacie JSON. Sortowanie nie zostało uruchomione. Spróbuj ponownie za chwilę.",
  invalid_output: "Model zwrócił wynik niezgodny z wymaganymi polami. Ten mail trzeba posortować ręcznie albo spróbować ponownie.",
  refused: "Model odmówił obsługi tego maila. Ten mail trzeba posortować ręcznie.",
  interrupted: "Sortowanie tego maila zostało przerwane albo trwało za długo. Spróbuj ponownie.",
  provider: "Błąd dostawcy AI przy tym mailu. Spróbuj ponownie za chwilę.",
} as const;

export type TriageErrorCode = keyof typeof TRIAGE_ERRORS;

export function isTriageErrorCode(value: unknown): value is TriageErrorCode {
  return typeof value === "string" && Object.hasOwn(TRIAGE_ERRORS, value);
}

// Maile oddziela linia, w której są tylko trzy myślniki (spacje wokół są dozwolone).
export function splitEmails(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/^[ \t]*---[ \t]*$/m)
    .map(part => part.trim()).filter(Boolean);
}

// Odpowiedź endpointu: karta na każdy mail, w kolejności wklejenia.
export const triageCardSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true), result: triageResultSchema,
    // Tytuły dokumentów, z których korzysta szkic, potwierdzone wynikiem wyszukiwania.
    sources: z.array(z.string()).max(10),
    // Komunikat, gdy bazy wiedzy nie udało się sprawdzić (szkic ma wtedy znaczniki braków).
    knowledgeNote: z.string().optional(),
  }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.string(), message: z.string() }) }),
]);
export const triageResponseSchema = z.strictObject({ cards: z.array(triageCardSchema).max(TRIAGE_MAX_EMAILS) });
export type TriageCard = z.infer<typeof triageCardSchema>;
