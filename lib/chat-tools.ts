import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { toolFailure, toolFailureSchema } from "./tool-result";

export function needsCurrentDate(text: string) {
  return /(?:^|[^\p{L}])(?:ostatnio|ostatni\p{L}*|najnowsz\p{L}*|aktualn\p{L}*|niedawno|obecnie|teraz|dzisiaj|dziś|jutro|wczoraj|za\s+ile\s+dni|co\s+nowego)(?=$|[^\p{L}])/iu.test(text);
}

export function warsawTime(now = new Date(), strefa = "Europe/Warsaw") {
  const parts = new Intl.DateTimeFormat("pl-PL", {
    timeZone: strefa,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    data: `${values.year}-${values.month}-${values.day}`,
    dzienTygodnia: values.weekday,
    godzina: `${values.hour}:${values.minute}:${values.second}`,
    strefa,
  };
}

export const aktualnyCzas = tool({
  description: "Sprawdza bieżącą datę, dzień tygodnia i godzinę w wybranej strefie IANA (parametr strefa), domyślnie Europe/Warsaw. " +
    "Użyj przed wyszukiwaniem przy pytaniach o «ostatnio», «najnowsze», «co nowego», " +
    "«aktualnie», «dziś», «jutro», «wczoraj», aktualną godzinę lub «za ile dni», " +
    "aby ustalić dzisiejszą datę przed obliczeniem dat względnych. " +
    "Użyj też przy pytaniach o czas w wybranej strefie, np. America/New_York, Asia/Tokyo lub UTC. " +
    "Nieznana strefa zwraca czytelny komunikat zamiast godziny.",
  inputSchema: z.strictObject({
    strefa: z.string().trim().min(1).max(100).optional()
      .describe("Strefa IANA, np. Europe/Warsaw, America/New_York, Asia/Tokyo lub UTC. Domyślnie Europe/Warsaw."),
  }),
  outputSchema: z.union([z.object({
    data: z.iso.date(),
    dzienTygodnia: z.string(),
    godzina: z.string(),
    strefa: z.string(),
    pobranoAt: z.iso.datetime().optional(),
  }), toolFailureSchema]),
  execute: async ({ strefa }) => {
    const now = new Date();
    try { return { ...warsawTime(now, strefa), pobranoAt: now.toISOString() }; }
    catch { return toolFailure("Nie rozpoznano strefy czasowej. Podaj strefę IANA, np. Europe/Warsaw lub Asia/Tokyo."); }
  },
});

export const czas = aktualnyCzas;
