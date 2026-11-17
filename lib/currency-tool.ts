import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { apiOptions, toolFailure, toolFailureSchema } from "./tool-result";

// https://api.nbp.pl/ — rates/{table}/{code}/; mid = PLN za 1 jednostkę waluty.
export const currencyInputSchema = z.strictObject({
  waluta: z.string().trim().regex(/^[A-Za-z]{3}$/).describe("Kod ISO waluty, np. EUR, USD, CHF."),
  kwota: z.number().finite().min(0).max(1e12).optional().describe("Opcjonalna kwota do przeliczenia."),
  kierunek: z.enum(["doPLN", "zPLN"]).optional().describe("doPLN: waluta → złote; zPLN: złote → waluta. Domyślnie doPLN."),
});
const rateSchema = z.object({
  code: z.string(), currency: z.string(),
  rates: z.array(z.object({ effectiveDate: z.iso.date(), mid: z.number().positive() })).length(1),
});
const outputSchema = z.discriminatedUnion("ok", [toolFailureSchema, z.object({
  ok: z.literal(true), waluta: z.string(), nazwa: z.string(), kursPLN: z.number(),
  dataKursu: z.iso.date(), kwota: z.number().optional(), wynik: z.number().optional(),
  walutaWyniku: z.string().optional(), pobranoAt: z.iso.datetime(), zrodlo: z.string(),
})]);

export async function fetchCurrency(raw: z.infer<typeof currencyInputSchema>, abortSignal?: AbortSignal): Promise<z.infer<typeof outputSchema>> {
  const parsed = currencyInputSchema.safeParse(raw);
  if (!parsed.success) return toolFailure("Podaj trzyznakowy kod waluty i nieujemną, skończoną kwotę.");
  const input = parsed.data;
  const code = input.waluta.toUpperCase();
  if (code === "PLN") return toolFailure("PLN to waluta bazowa: 1 PLN = 1 PLN. Podaj kod waluty obcej, np. EUR.");
  try {
    const options = apiOptions(abortSignal);
    for (const table of ["a", "b"]) {
      const url = `https://api.nbp.pl/api/exchangerates/rates/${table}/${code}/?format=json`;
      const response = await fetch(url, options);
      if (response.status === 404) continue;
      if (!response.ok) return toolFailure("NBP nie udostępnia teraz kursów walut. Spróbuj ponownie za chwilę.");
      const data = rateSchema.parse(await response.json());
      if (data.code.toUpperCase() !== code) return toolFailure("NBP zwrócił kurs innej waluty. Spróbuj ponownie.");
      const rate = data.rates[0];
      const result = input.kwota === undefined ? undefined
        : input.kierunek === "zPLN" ? input.kwota / rate.mid : input.kwota * rate.mid;
      if (result !== undefined && !Number.isFinite(result)) return toolFailure("Kwota jest zbyt duża do przeliczenia.");
      return {
        ok: true, waluta: code, nazwa: data.currency, kursPLN: rate.mid, dataKursu: rate.effectiveDate,
        ...(result === undefined ? {} : {
          kwota: input.kwota, wynik: Math.round((result + Number.EPSILON) * 100) / 100,
          walutaWyniku: input.kierunek === "zPLN" ? code : "PLN",
        }),
        pobranoAt: new Date().toISOString(), zrodlo: url,
      };
    }
    return toolFailure(`Nie znaleziono kursu ${code} w tabelach A i B NBP. Sprawdź kod waluty.`);
  } catch {
    return toolFailure("Nie udało się pobrać kursu NBP: usługa nie odpowiada lub zwróciła niepełne dane. Spróbuj ponownie.");
  }
}

export const waluty = tool({
  description: "Sprawdza ostatni opublikowany kurs średni waluty wobec PLN w NBP (tabele A i B), opcjonalnie przelicza kwotę w obie strony. " +
    "Użyj przy pytaniach o kursy i przeliczenia walut; podaj kod ISO. Data publikacji może być wcześniejsza niż dziś (weekendy/święta). To kurs średni, bez marży banku. Wynik kwoty jest zaokrąglony do 2 miejsc.",
  inputSchema: currencyInputSchema, outputSchema,
  execute: async (input, { abortSignal }) => fetchCurrency(input, abortSignal),
});
