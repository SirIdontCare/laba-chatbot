import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { searchCities, CityLookupError, citySchema } from "./city-search";

// Dokumentacja: https://open-meteo.com/en/docs i /en/docs/geocoding-api
const inputSchema = z.object({
  miejscowosc: z.string().trim().min(2).max(120)
    .describe("Nazwa miejscowości, opcjonalnie z regionem po przecinku, np. Warszawa lub Springfield, Illinois."),
  kodKraju: z.string().regex(/^[A-Z]{2}$/).optional()
    .describe("Kod kraju ISO, np. PL lub DE. Podaj, jeśli kraj wynika z pytania lub kontekstu."),
  dzien: z.iso.date().optional().describe("Data prognozy YYYY-MM-DD w lokalnej strefie miasta (dziś lub do 15 dni naprzód). Bez daty zwraca pogodę bieżącą."),
});

const locationSchema = z.object({
  name: z.string(), latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  country: z.string().optional(), admin1: z.string().optional(),
});
const geocodingSchema = z.object({ results: z.array(locationSchema).optional() });
const forecastSchema = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(), interval: z.number().positive(),
    temperature_2m: z.number(), apparent_temperature: z.number(),
    precipitation: z.number().nonnegative(), weather_code: z.number().int(),
    wind_speed_10m: z.number().nonnegative(),
  }),
});
const dailySchema = z.object({
  timezone: z.string(),
  daily: z.object({
    time: z.array(z.iso.date()).length(1),
    temperature_2m_min: z.array(z.number()).length(1), temperature_2m_max: z.array(z.number()).length(1),
    precipitation_sum: z.array(z.number().nonnegative()).length(1),
    precipitation_probability_max: z.array(z.number().min(0).max(100)).length(1),
    wind_speed_10m_max: z.array(z.number().nonnegative()).length(1),
    weather_code: z.array(z.number().int()).length(1),
  }),
});
const outputSchema = z.union([
  z.object({
    ok: z.literal(true), miejscowosc: z.string(),
    temperaturaC: z.number(), odczuwalnaC: z.number(), opis: z.string(),
    wiatrKmh: z.number(), opadyMm: z.number(), okresOpadowMin: z.number(),
    czasDanych: z.string(), strefa: z.string(),
    pobranoAt: z.iso.datetime(), zrodlo: z.literal("https://open-meteo.com/"),
  }),
  z.object({ ok: z.literal(false), komunikat: z.string(), sprawdzonoAt: z.iso.datetime() }),
  z.object({
    ok: z.literal(true), rodzaj: z.literal("prognoza"), miejscowosc: z.string(), dzien: z.iso.date(),
    temperaturaMinC: z.number(), temperaturaMaxC: z.number(), opadyMm: z.number(),
    prawdopodobienstwoOpadowProc: z.number(), wiatrMaxKmh: z.number(), opis: z.string(),
    strefa: z.string(), pobranoAt: z.iso.datetime(), zrodlo: z.literal("https://open-meteo.com/"),
  }),
]);

const weatherDescriptions: Record<number, string> = {
  0: "bezchmurnie", 1: "przeważnie pogodnie", 2: "częściowe zachmurzenie", 3: "pochmurno",
  45: "mgła", 48: "mgła osadzająca szadź",
  51: "lekka mżawka", 53: "umiarkowana mżawka", 55: "intensywna mżawka",
  56: "lekka marznąca mżawka", 57: "intensywna marznąca mżawka",
  61: "słaby deszcz", 63: "umiarkowany deszcz", 65: "silny deszcz",
  66: "słaby marznący deszcz", 67: "silny marznący deszcz",
  71: "słaby śnieg", 73: "umiarkowany śnieg", 75: "silny śnieg", 77: "śnieg ziarnisty",
  80: "słabe przelotne opady deszczu", 81: "umiarkowane przelotne opady deszczu",
  82: "gwałtowne przelotne opady deszczu", 85: "słabe przelotne opady śniegu",
  86: "silne przelotne opady śniegu", 95: "burza", 96: "burza ze słabym gradem",
  97: "silna burza", 99: "burza z silnym gradem",
};

export async function fetchWeather(input: z.infer<typeof inputSchema>, abortSignal?: AbortSignal, resolvedCity?: z.infer<typeof citySchema>):
  Promise<z.infer<typeof outputSchema>> {
  const failure = (komunikat: string) => ({ ok: false as const, komunikat, sprawdzonoAt: new Date().toISOString() });
  const checked = inputSchema.safeParse(input);
  if (!checked.success) return failure("Podaj nazwę miejscowości, opcjonalnie kod kraju i poprawną datę YYYY-MM-DD.");
  input = checked.data;
  try {
    const timeout = AbortSignal.timeout(10000);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    const options = { signal, cache: "no-store" as const };
    const results = resolvedCity ? [citySchema.parse(resolvedCity)] : await searchCities(input.miejscowosc, input.kodKraju, signal);
    const locationName = (place: z.infer<typeof locationSchema>) =>
      [place.name, place.admin1, place.country].filter(Boolean).join(", ");
    if (!results.length) return failure("Nie znaleziono miejscowości. Podaj jej nazwę i kraj.");
    if (results.length > 1) return failure("Znaleziono kilka miejscowości: " +
      results.map(locationName).join("; ") + ". Doprecyzuj kraj lub region.");
    const location = results[0];
    if (input.dzien) {
      // Zasięg prognozy odnosimy do dnia w lokalnej strefie wybranej miejscowości.
      const todayUrl = new URL("https://api.open-meteo.com/v1/forecast");
      todayUrl.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude),
        daily: "temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,weather_code",
        start_date: input.dzien, end_date: input.dzien, timezone: "auto",
        temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm" }).toString();
      const response = await fetch(todayUrl, options);
      if (response.status === 400) return failure("Prognoza dla tego dnia jest niedostępna. Wybierz dzień od dziś do 15 dni naprzód w strefie miasta.");
      if (!response.ok) return failure("Open-Meteo nie udostępnia teraz prognozy. Spróbuj ponownie za chwilę.");
      const { daily, timezone } = dailySchema.parse(await response.json());
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date());
      const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      const today = Date.parse(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
      const offset = (Date.parse(`${input.dzien}T00:00:00Z`) - today) / 86400000;
      if (offset < 0 || offset > 15) return failure("Prognoza obejmuje dziś i najbliższe 15 dni. Dla dat historycznych prognoza nie jest dostępna.");
      if (daily.time[0] !== input.dzien || daily.temperature_2m_min[0] > daily.temperature_2m_max[0]) {
        return failure("Open-Meteo zwróciło niezgodną prognozę. Spróbuj ponownie.");
      }
      return { ok: true, rodzaj: "prognoza", miejscowosc: locationName(location), dzien: daily.time[0],
        temperaturaMinC: daily.temperature_2m_min[0], temperaturaMaxC: daily.temperature_2m_max[0],
        opadyMm: daily.precipitation_sum[0], prawdopodobienstwoOpadowProc: daily.precipitation_probability_max[0],
        wiatrMaxKmh: daily.wind_speed_10m_max[0], opis: weatherDescriptions[daily.weather_code[0]] ?? "brak opisu warunków pogodowych",
        strefa: timezone, pobranoAt: new Date().toISOString(), zrodlo: "https://open-meteo.com/" };
    }
    const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
    weatherUrl.search = new URLSearchParams({
      latitude: String(location.latitude), longitude: String(location.longitude),
      current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation",
      timezone: "auto", temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm",
    }).toString();
    const weatherResponse = await fetch(weatherUrl, options);
    if (!weatherResponse.ok) return failure("Open-Meteo nie udostępnia teraz pogody. Spróbuj ponownie za chwilę.");
    const { current, timezone } = forecastSchema.parse(await weatherResponse.json());
    return {
      ok: true, miejscowosc: locationName(location),
      temperaturaC: current.temperature_2m, odczuwalnaC: current.apparent_temperature,
      opis: weatherDescriptions[current.weather_code] ?? "brak opisu warunków pogodowych",
      wiatrKmh: current.wind_speed_10m, opadyMm: current.precipitation,
      okresOpadowMin: current.interval / 60, czasDanych: current.time, strefa: timezone,
      pobranoAt: new Date().toISOString(), zrodlo: "https://open-meteo.com/",
    };
  } catch (error) {
    if (error instanceof CityLookupError) return failure(error.message);
    if (abortSignal?.aborted) return failure("źródło nie odpowiada");
    return failure("Nie udało się pobrać pogody z Open-Meteo: przekroczono czas oczekiwania, usługa jest niedostępna lub zwróciła niepełne dane. Spróbuj ponownie za chwilę.");
  }
}

export const pogoda = tool({
  description: "Pobiera pogodę bieżącą lub prognozę dzienną dla miejscowości z Open-Meteo (geokodowanie i prognoza). " +
    "Użyj przy pytaniach o temperaturę, wiatr, opady lub pogodę. Dla konkretnego dnia podaj dzien YYYY-MM-DD w strefie miasta; bez dnia zwraca pogodę teraz. " +
    "Gdy brakuje miejscowości, zapytaj użytkownika. Nie zgaduj jego lokalizacji. " +
    "Prognoza obejmuje dziś i do 15 dni naprzód; nie podaje historii. Dla prognozy opadyMm to suma dobowa, wiatr to maksimum dobowe. " +
    "Przy kilku pasujących miejscowościach poproś o doprecyzowanie kraju lub regionu.",
  inputSchema,
  outputSchema,
  execute: async (input, { abortSignal }) => fetchWeather(input, abortSignal),
});
