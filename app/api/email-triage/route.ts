import { requestUser } from "../../../lib/supabase-server";
import { sameOrigin } from "../../../lib/request-origin";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { triageEmails } from "../../../lib/email-triage";
import { splitEmails, TRIAGE_ERRORS, triageRequestSchema, type TriageErrorCode } from "../../../lib/email-triage-schema";

export const maxDuration = 120;

function triageFailure(code: TriageErrorCode, status: number) {
  return Response.json({ error: { code, message: TRIAGE_ERRORS[code] } }, {
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
    return triageFailure("input", 400);
  }
  const input = triageRequestSchema.safeParse(body);
  if (!input.success) {
    const tooLong = input.error.issues.some(issue => issue.code === "too_big");
    return triageFailure(tooLong ? "inputTooLong" : "input", 400);
  }

  // Podział na maile odbywa się na serwerze, niezależnie od tego, co policzyła przeglądarka.
  const outcome = await triageEmails(splitEmails(input.data.text), request.signal);
  if (!outcome.ok) return triageFailure(outcome.code, outcome.status);
  // Wynik to tylko tekst do przeczytania: nic nie jest wysyłane ani zapisywane.
  return Response.json({ cards: outcome.cards }, { headers: { "Cache-Control": "no-store" } });
}
