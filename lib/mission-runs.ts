import "server-only";
import { z } from "zod";
import type { SignedInUser } from "./supabase-server";
import type { Mission } from "./missions";
import { missionSourceSchema, parseMissionResult, type MissionRunSummary, type SavedMissionRun } from "./mission-schema";

// Wyniki misji zapisujemy w tabeli mission_runs (kolumny mission, input, result; user_id wypełnia baza)
// klientem bazy zalogowanej osoby, jak rozmowy: klucz publishable + token z jej sesji, więc
// pilnuje RLS „tylko własne wiersze”. Nigdy kluczem secret. Filtr .eq("user_id", owner.id)
// to dodatkowe zabezpieczenie: identyfikator pochodzi wyłącznie ze zweryfikowanej sesji.
// Zakładamy kolumny id i created_at (domyślnie now()), używane do listy i otwierania wyników.
export type MissionRunOwner = Pick<SignedInUser, "db" | "id">;

export const RECENT_RUNS = 5;

// Zapisany wynik: to samo, co endpoint pokazał na ekranie. Działa dla kolumny result
// typu jsonb (obiekt) i text (JSON jako tekst).
const storedReportSchema = z.object({
  result: z.unknown(),
  sources: z.array(missionSourceSchema).max(30),
  completedAt: z.iso.datetime(),
});

const runRowSchema = z.object({
  id: z.union([z.string(), z.number()]),
  mission: z.string(),
  created_at: z.string(),
});

// Wejście: przy jednym polu sam tekst (np. notatki), przy kilku obiekt pól.
function storedInput(mission: Mission, input: Record<string, string>) {
  return mission.fields.length === 1 ? input[mission.fields[0].name] : input;
}

function readJson(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export async function saveMissionRun(owner: MissionRunOwner, mission: Mission, input: Record<string, string>,
  report: z.infer<typeof storedReportSchema>): Promise<MissionRunSummary> {
  const { data, error } = await owner.db.from("mission_runs")
    .insert({ mission: mission.id, input: storedInput(mission, input), result: report })
    .select("id, mission, created_at")
    .abortSignal(AbortSignal.timeout(10_000))
    .single();
  const row = runRowSchema.safeParse(data);
  if (error || !row.success) throw new Error("Supabase mission run save failed.");
  return { id: String(row.data.id), mission: row.data.mission, createdAt: row.data.created_at };
}

// Pięć ostatnich wykonań danej misji tej osoby, od najnowszego.
export async function listMissionRuns(owner: MissionRunOwner, missionId: string): Promise<MissionRunSummary[]> {
  const { data, error } = await owner.db.from("mission_runs")
    .select("id, mission, created_at")
    .eq("user_id", owner.id).eq("mission", missionId)
    .order("created_at", { ascending: false })
    .limit(RECENT_RUNS)
    .abortSignal(AbortSignal.timeout(10_000));
  if (error || !Array.isArray(data)) throw new Error("Supabase mission runs read failed.");
  return data.flatMap(item => {
    const row = runRowSchema.safeParse(item);
    return row.success ? [{ id: String(row.data.id), mission: row.data.mission, createdAt: row.data.created_at }] : [];
  });
}

// Zapisany wynik albo null, gdy go nie ma, należy do innej osoby albo nie pasuje do układu misji.
export async function loadMissionRun(owner: MissionRunOwner, runId: string, findMission: (id: string) => Mission | undefined):
  Promise<SavedMissionRun | null> {
  const { data, error } = await owner.db.from("mission_runs")
    .select("id, mission, input, result, created_at")
    .eq("user_id", owner.id).eq("id", runId)
    .abortSignal(AbortSignal.timeout(10_000))
    .maybeSingle();
  // Zły format identyfikatora (np. tekst zamiast liczby) PostgREST zgłasza jako błąd: traktujemy jak brak.
  if (error && error.code !== "22P02") throw new Error("Supabase mission run read failed.");
  const row = runRowSchema.safeParse(data);
  if (!data || !row.success) return null;
  const mission = findMission(row.data.mission);
  const report = storedReportSchema.safeParse(readJson((data as { result: unknown }).result));
  if (!mission || !report.success) return null;
  const checked = parseMissionResult(mission.layout, report.data.result, report.data.sources.length);
  if (!checked.success) return null;
  const rawInput = readJson((data as { input: unknown }).input);
  const input = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? "", null, 1);
  return {
    id: String(row.data.id), mission: mission.id, createdAt: row.data.created_at, input: input.slice(0, 20_000),
    report: { result: checked.data, sources: report.data.sources, completedAt: report.data.completedAt },
  };
}
