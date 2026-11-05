import { ANALYSIS_ERRORS, type AnalysisErrorCode } from "../../../lib/analysis-errors";
import { AnalysisError, analyzeMessage } from "../../../lib/analyze-message";
import { analysisRequestSchema } from "../../../lib/analysis-schema";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { requestToken, validSession, sameOrigin } from "../../../lib/session";

function failure(code: AnalysisErrorCode, status: number) {
  return Response.json({ error: { code, message: ANALYSIS_ERRORS[code] } }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  if (!(await validSession(requestToken(request)))) {
    return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  }
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });

  let message: string;
  try {
    const input = analysisRequestSchema.safeParse(await request.json());
    if (!input.success) return failure("input", 400);
    message = input.data.message;
  } catch {
    return failure(request.signal.aborted ? "interrupted" : "input", 400);
  }

  // Konfiguracja i klucz pozostają wyłącznie na serwerze.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) return failure("configuration", 503);

  try {
    const result = await analyzeMessage({ message, apiKey, model, signal: request.signal });
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = request.signal.aborted ? "interrupted"
      : error instanceof AnalysisError ? error.code : "provider";
    return failure(code, code === "unsupported" || code === "capability" ? 503 : 502);
  }
}
