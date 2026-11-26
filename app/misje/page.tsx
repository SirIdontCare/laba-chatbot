import { notFound, redirect } from "next/navigation";
import { loginPath } from "../../lib/redirect-target";
import { currentUser } from "../../lib/supabase-server";
import { findMission, publicMissions } from "../../lib/missions";
import { listMissionRuns, loadMissionRun } from "../../lib/mission-runs";
import type { MissionRunSummary, SavedMissionRun } from "../../lib/mission-schema";
import MissionsClient from "./missions-client";

export default async function MissionsPage({ searchParams }: { searchParams: Promise<{ run?: string | string[] }> }) {
  const params = await searchParams;
  const runId = typeof params.run === "string" ? params.run : undefined;
  // Strona tylko dla zalogowanych: bez zweryfikowanej sesji przekierowanie na logowanie.
  const user = await currentUser();
  if (!user) redirect(loginPath(runId ? `/misje?run=${encodeURIComponent(runId)}` : "/misje"));

  const missions = publicMissions();
  // Historia (5 ostatnich wykonań) tylko dla misji z zapisem; czytana klientem bazy tej osoby (RLS).
  const runs: Record<string, MissionRunSummary[] | null> = {};
  for (const mission of missions.filter(item => item.saveRuns)) {
    try { runs[mission.id] = await listMissionRuns(user, mission.id); } catch { runs[mission.id] = null; }
  }

  // Otwarty zapisany wynik: brak, cudzy albo zły identyfikator → 404 bez żadnych danych.
  let openedRun: SavedMissionRun | null = null;
  let runLoadError = false;
  if (runId !== undefined) {
    if (!/^[\w-]{1,64}$/.test(runId)) notFound();
    try { openedRun = await loadMissionRun(user, runId, id => findMission(id)); } catch { runLoadError = true; }
    if (!openedRun && !runLoadError) notFound();
  }

  // Do przeglądarki trafia lista misji bez instrukcji dla modelu.
  return <MissionsClient key={openedRun?.id ?? "new"} account={user.account} missions={missions} runs={runs}
    openedRun={openedRun} runLoadError={runLoadError} />;
}
