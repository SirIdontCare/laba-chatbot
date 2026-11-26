import { z } from "zod";
import { requestUser } from "../../../lib/supabase-server";
import { sameOrigin } from "../../../lib/request-origin";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { findMission } from "../../../lib/missions";
import { runMission } from "../../../lib/mission-runner";
import { layoutInputError, MISSION_ERRORS, missionInputSchema, type MissionErrorCode } from "../../../lib/mission-schema";

export const maxDuration = 120;

const requestSchema = z.strictObject({ missionId: z.string().max(50), input: z.unknown() });

function missionFailure(code: MissionErrorCode, status: number) {
  return Response.json({ error: { code, message: MISSION_ERRORS[code] } }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  // Ta sama bramka co w /api/agent: najpierw zweryfikowana osoba, potem dane i model.
  const user = await requestUser(request);
  if (!user) return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return missionFailure("input", 400);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return missionFailure("input", 400);
  const mission = findMission(parsed.data.missionId);
  if (!mission) return missionFailure("unknown", 404);
  const input = missionInputSchema(mission.fields).safeParse(parsed.data.input);
  if (!input.success) return missionFailure("input", 400);
  const values = input.data as Record<string, string>;
  // Np. porównanie: 2–5 różnych kryteriów i trzy różne firmy, zanim cokolwiek trafi do modelu.
  const layoutError = layoutInputError(mission.layout, values);
  if (layoutError) return missionFailure(layoutError, 400);

  const outcome = await runMission(mission, values, request.signal);
  if (!outcome.ok) return missionFailure(outcome.code, outcome.status);
  // Wynik to tylko tekst do przeczytania: nic nie jest zapisywane w bazie ani wysyłane.
  return Response.json({ result: outcome.result, sources: outcome.sources }, { headers: { "Cache-Control": "no-store" } });
}
