import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { apiOptions, toolFailure, toolFailureSchema } from "./tool-result";

// Nager.Date v3: https://date.nager.at/Api; aktualna dokumentacja: https://nagerholidays.com/api
export const holidaysInputSchema = z.strictObject({
  kodKraju: z.string().trim().regex(/^[A-Za-z]{2}$/).describe("Kod kraju ISO 3166-1 alpha-2, np. PL, DE, US."),
  rok: z.number().int().min(1900).max(2100),
});
const holidaySchema = z.object({
  date: z.iso.date(), localName: z.string(), name: z.string(), countryCode: z.string(),
  global: z.boolean(), counties: z.array(z.string()).nullable(), types: z.array(z.string()),
});
const outputSchema = z.discriminatedUnion("ok", [toolFailureSchema, z.object({
  ok: z.literal(true), kodKraju: z.string(), rok: z.number(),
  swieta: z.array(z.object({ data: z.iso.date(), nazwa: z.string(), calyKraj: z.boolean(), regiony: z.array(z.string()) })),
  pobranoAt: z.iso.datetime(), zrodlo: z.string(),
})]);

export async function fetchHolidays(raw: z.infer<typeof holidaysInputSchema>, abortSignal?: AbortSignal): Promise<z.infer<typeof outputSchema>> {
  const parsed = holidaysInputSchema.safeParse(raw);
  if (!parsed.success) return toolFailure("Podaj dwuliterowy kod kraju i rok od 1900 do 2100.");
  const { rok } = parsed.data;
  const kodKraju = parsed.data.kodKraju.toUpperCase();
  const url = `https://date.nager.at/api/v3/PublicHolidays/${rok}/${kodKraju}`;
  try {
    const response = await fetch(url, apiOptions(abortSignal));
    if (response.status === 404) return toolFailure("Nie znaleziono tego kraju w Nager.Date. Sprawdź kod kraju lub wybierz obsługiwany kraj.");
    if (!response.ok) return toolFailure("Nager.Date nie udostępnia teraz kalendarza. Spróbuj ponownie za chwilę.");
    const holidays = response.status === 204 ? [] : z.array(holidaySchema).max(500).parse(await response.json());
    if (holidays.some((day) => day.countryCode !== kodKraju || !day.date.startsWith(`${rok}-`))) {
      return toolFailure("Nager.Date zwrócił dane dla innego kraju lub roku. Spróbuj ponownie.");
    }
    return {
      ok: true, kodKraju, rok,
      swieta: holidays.filter((day) => day.types.includes("Public")).map((day) => ({
        data: day.date, nazwa: day.localName || day.name, calyKraj: day.global, regiony: day.counties ?? [],
      })),
      pobranoAt: new Date().toISOString(), zrodlo: url,
    };
  } catch {
    return toolFailure("Nie udało się pobrać świąt z Nager.Date: usługa nie odpowiada lub zwróciła niepełne dane. Spróbuj ponownie.");
  }
}

export const swieta = tool({
  description: "Pobiera święta publiczne (Public) z Nager.Date dla kraju i roku. Użyj do pytań o dni wolne i kalendarz świąt. " +
    "Zachowaj informację, czy święto obejmuje cały kraj czy wskazane regiony; nie przedstawiaj regionalnego jako ogólnokrajowego. " +
    "Nie obejmuje wszystkich weekendów ani urlopów; faktyczne prawo do wolnego może zależeć od regionu i zawodu. Brak kraju lub roku — dopytaj.",
  inputSchema: holidaysInputSchema, outputSchema,
  execute: async (input, { abortSignal }) => fetchHolidays(input, abortSignal),
});
