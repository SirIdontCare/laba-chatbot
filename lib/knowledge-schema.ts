import { z } from "zod";

// Ile najlepiej pasujących fragmentów zwraca searchKnowledge.
export const KB_MATCH_COUNT = 3;

// Próg podobieństwa (cosinus, 0-1): fragment poniżej progu nie trafia do modelu ani do listy źródeł.
// Dobrany 2026-11-19 na 34 pytaniach do bazy (Cennik 2026, Cennik 2026 v2, FAQ),
// model openai/text-embedding-3-small:
// - fragment z właściwą odpowiedzią: od 0,486 („Czy obsługujecie język niemiecki?”) do 0,838,
// - pytania spoza firmy (pogoda, pierogi, mundial): najwyżej 0,325,
// - pytania o firmę bez odpowiedzi w bazie (WhatsApp, SMS, biuro): 0,37-0,55.
// 0,45 odcina pytania spoza firmy i zostawia każdą znalezioną odpowiedź. Fragmenty 0,45-0,55
// na podobny temat, ale bez odpowiedzi, odrzuca model (zasada 4 w instrukcji czatu).
// Zmiana modelu embeddingów albo dokumentów = zmierz próg od nowa.
export const KB_MIN_SIMILARITY = 0.45;

export const knowledgeFragmentSchema = z.object({
  tytul: z.string(), tresc: z.string(), podobienstwo: z.number(),
});
export type KnowledgeFragment = z.infer<typeof knowledgeFragmentSchema>;

// Wspólne dla serwera i przeglądarki (lib/tool-result.ts jest server-only), ten sam kształt błędu.
const failureSchema = z.object({ ok: z.literal(false), komunikat: z.string(), pobranoAt: z.iso.datetime() });

export const knowledgeOutputSchema = z.discriminatedUnion("ok", [failureSchema, z.object({
  ok: z.literal(true),
  fragmenty: z.array(knowledgeFragmentSchema),
  komunikat: z.string().optional(),
  pobranoAt: z.iso.datetime(),
})]);

// Tytuły z linii „📎 Źródło: [tytuł]” (lub „Źródła: A, B”) w odpowiedzi agenta.
export function citedTitles(answer: string) {
  const titles = new Set<string>();
  for (const match of answer.matchAll(/📎\s*Źródł[oa]\s*:\s*(.+)/gu)) {
    const clean = (value: string) => value.trim().replace(/^\[|\]$/g, "").replace(/^[„"]|[”"]$/g, "").trim();
    titles.add(clean(match[1]));
    for (const part of match[1].split(/,|;|\s+i\s+/u)) titles.add(clean(part));
  }
  titles.delete("");
  return titles;
}

// Fragmenty, z których odpowiedź korzysta: zwrócone przez searchKnowledge (już powyżej progu)
// i pochodzące z dokumentu wskazanego w linii źródła. Bez linii źródła: brak źródeł.
export function usedKnowledgeFragments(outputs: unknown[], answer: string): KnowledgeFragment[] {
  const titles = citedTitles(answer);
  const seen = new Set<string>();
  const used: KnowledgeFragment[] = [];
  for (const output of outputs) {
    const parsed = knowledgeOutputSchema.safeParse(output);
    if (!parsed.success || !parsed.data.ok) continue;
    for (const fragment of parsed.data.fragmenty) {
      const key = `${fragment.tytul}\n${fragment.tresc}`;
      if (fragment.podobienstwo < KB_MIN_SIMILARITY || !titles.has(fragment.tytul) || seen.has(key)) continue;
      seen.add(key);
      used.push(fragment);
    }
  }
  return used.sort((a, b) => b.podobienstwo - a.podobienstwo);
}
