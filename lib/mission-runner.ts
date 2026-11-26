import "server-only";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, isStepCount, NoObjectGeneratedError, Output } from "ai";
import { AnalysisError, hasRefusal, requireStructuredOutput } from "./analyze-message";
import { warsawTime } from "./chat-tools";
import { webSearchTool } from "./model";
import { AGENT_STEP_LIMIT } from "./tool-catalog";
import type { Mission } from "./missions";
import {
  MISSION_TIME_LIMIT_MS, missionModelSchema, missionResultSchema, missionSourceSchema,
  type MissionErrorCode, type MissionSource,
} from "./mission-schema";

export type MissionOutcome =
  | { ok: true; result: Record<string, string | string[]>; sources: MissionSource[] }
  | { ok: false; code: MissionErrorCode; status: number };

const fail = (code: MissionErrorCode, status: number): MissionOutcome => ({ ok: false, code, status });

// Źródła wyłącznie z odpowiedzi wyszukiwarki (części "source" od OpenRoutera, ze wszystkich kroków),
// bez duplikatów i tylko http/https. Adresy wpisane przez model w tekst nie są tu brane pod uwagę.
function searchSources(steps: { sources: readonly { sourceType: string; url?: string; title?: string }[] }[]): MissionSource[] {
  const seen = new Set<string>();
  const sources: MissionSource[] = [];
  for (const source of steps.flatMap(step => step.sources)) {
    if (source.sourceType !== "url" || !source.url || seen.has(source.url)) continue;
    const parsed = missionSourceSchema.safeParse({ url: source.url, title: source.title?.trim() || new URL(source.url).hostname });
    if (!parsed.success) continue;
    seen.add(source.url);
    sources.push(parsed.data);
    if (sources.length >= 20) break;
  }
  return sources;
}

export async function runMission(mission: Mission, input: Record<string, string>, signal: AbortSignal): Promise<MissionOutcome> {
  // Klucz i model są odczytywane wyłącznie na serwerze.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) return fail("configuration", 503);

  const timeout = AbortSignal.timeout(MISSION_TIME_LIMIT_MS);
  const abortSignal = AbortSignal.any([signal, timeout]);
  try {
    await requireStructuredOutput(model, abortSignal);
  } catch (error) {
    if (timeout.aborted) return fail("timeout", 504);
    if (signal.aborted) return fail("interrupted", 400);
    return fail(error instanceof AnalysisError && error.code === "unsupported" ? "unsupported" : "capability", 503);
  }

  const openrouter = createOpenRouter({ apiKey });
  let refused = false;
  try {
    const now = warsawTime();
    const result = await generateText({
      model: openrouter.chat(model, {
        structuredOutputs: { strict: true },
        provider: { require_parameters: true },
      }),
      tools: mission.webSearch ? { web_search: webSearchTool(openrouter, { maxResults: 5 }) } : undefined,
      output: Output.object({ schema: missionModelSchema(mission.sections), name: `misja_${mission.id}` }),
      instructions: `${mission.instructions}\n\nBieżąca data: ${now.data} (${now.dzienTygodnia}, ${now.strefa}).`,
      messages: [{ role: "user", content: mission.prompt(input) }],
      // Ten sam limit kroków co w czacie; do tego minuta na całą misję.
      stopWhen: isStepCount(AGENT_STEP_LIMIT),
      abortSignal,
      maxRetries: 0,
      include: { responseBody: true },
      onStepEnd: ({ finishReason, response }) => {
        if (finishReason === "content-filter" || hasRefusal(response.body)) refused = true;
      },
    });
    if (timeout.aborted) return fail("timeout", 504);
    if (abortSignal.aborted) return fail("interrupted", 400);
    if (refused) return fail("refused", 502);
    if (result.finishReason !== "stop") return fail("interrupted", 502);

    // Pełne sprawdzenie sekcji na serwerze (kolejność wynika z definicji misji).
    const validated = missionResultSchema(mission.sections).safeParse(result.output);
    if (!validated.success) return fail("invalid_output", 502);
    return { ok: true, result: validated.data as Record<string, string | string[]>, sources: searchSources(result.steps) };
  } catch (error) {
    if (timeout.aborted) return fail("timeout", 504);
    if (signal.aborted) return fail("interrupted", 400);
    if (refused) return fail("refused", 502);
    if (NoObjectGeneratedError.isInstance(error)) return fail("invalid_output", 502);
    // Bez surowej odpowiedzi, sekretów i treści zapytania w komunikacie lub logach.
    return fail("provider", 502);
  }
}
