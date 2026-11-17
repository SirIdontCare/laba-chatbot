import "server-only";
import { ANALYSIS_ERRORS, type AnalysisErrorCode } from "./analysis-errors";
import { AnalysisError, analyzeMessage } from "./analyze-message";
import { analysisRequestSchema } from "./analysis-schema";

export function analysisFailure(code: AnalysisErrorCode, status: number) {
  return Response.json({ error: { code, message: ANALYSIS_ERRORS[code] } }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function agentAnalyze(request: Request, body: unknown) {
  let message: string;
  try {
    const input = analysisRequestSchema.safeParse(body);
    if (!input.success) return analysisFailure("input", 400);
    message = input.data.message;
  } catch {
    return analysisFailure(request.signal.aborted ? "interrupted" : "input", 400);
  }

  // Konfiguracja i klucz pozostają wyłącznie na serwerze.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) return analysisFailure("configuration", 503);

  try {
    const result = await analyzeMessage({ message, apiKey, model, signal: request.signal });
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = request.signal.aborted ? "interrupted"
      : error instanceof AnalysisError ? error.code : "provider";
    return analysisFailure(code, code === "unsupported" || code === "capability" ? 503 : 502);
  }
}
