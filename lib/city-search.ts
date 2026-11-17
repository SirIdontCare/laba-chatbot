import "server-only";
import { z } from 'zod';
import { apiOptions } from './tool-result';
export const citySchema = z.object({
  name: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  country: z.string().optional(), country_code: z.string().optional(), admin1: z.string().optional(),
  timezone: z.string().optional(), feature_code: z.string().optional(),
});
const responseSchema = z.object({ results: z.array(citySchema).optional(), generationtime_ms: z.number().optional() })
  .refine((data) => data.results !== undefined || data.generationtime_ms !== undefined);
export class CityLookupError extends Error {}
const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();
export async function searchCities(query: string, countryCode?: string, signal?: AbortSignal) {
  const [name, ...qualifiers] = query.split(',').map((s) => s.trim());
  const options = apiOptions(signal);
  for (const language of ['pl', 'en']) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '10', language, ...(countryCode ? { countryCode } : {}) }).toString();
    const response = await fetch(url, options);
    if (!response.ok) throw new CityLookupError('Nie udało się wyszukać miasta. Źródło nie odpowiada — spróbuj odświeżyć.');
    const checked = responseSchema.safeParse(await response.json());
    if (!checked.success) throw new CityLookupError('Nie udało się wyszukać miasta: źródło zwróciło niepoprawne dane. Spróbuj odświeżyć.');
    const results = checked.data.results ?? [];
    const filtered = results.filter((place) => qualifiers.every((q) => [place.country, place.country_code, place.admin1]
      .some((field) => field && normalize(field) === normalize(q))));
    if (filtered.length) {
      const capitals = filtered.filter((place) => place.feature_code === 'PPLC' && normalize(place.name) === normalize(name));
      return !qualifiers.length && capitals.length === 1 ? capitals : filtered;
    }
  }
  return [];
}
