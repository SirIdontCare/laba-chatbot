import "server-only";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { analysisSchema, type Analysis } from "./analysis-schema";
import { type AnalysisErrorCode } from "./analysis-errors";
import { STUDIO_NOVA_ANALYSIS_INSTRUCTIONS } from "./studio-nova";

export class AnalysisError extends Error {
  constructor(readonly code: AnalysisErrorCode) {
    super(code);
  }
}

const endpointsSchema = z.object({
  data: z.object({
    endpoints: z.array(z.object({ supported_parameters: z.array(z.string()) })),
  }),
});

export async function requireStructuredOutput(model: string, signal: AbortSignal) {
  try {
    // Publiczne metadane: bez klucza i bez wysyłania wiadomości klienta.
    const slug = model.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`https://openrouter.ai/api/v1/models/${slug}/endpoints`, {
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 404) throw new AnalysisError("unsupported");
    if (!response.ok) throw new AnalysisError("capability");
    const { data } = endpointsSchema.parse(await response.json());
    if (!data.endpoints.some(({ supported_parameters: params }) =>
      params.includes("structured_outputs") && params.includes("response_format"),
    )) throw new AnalysisError("unsupported");
  } catch (error) {
    if (signal.aborted) throw new AnalysisError("interrupted");
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError("capability");
  }
}

// OpenRouter 3.1 zachowuje surowe message.refusal w response.body.
export function hasRefusal(body: unknown) {
  const response = z.object({
    choices: z.array(z.object({
      message: z.object({ refusal: z.unknown().optional() }),
    })),
  }).safeParse(body);
  return response.success && response.data.choices.some(({ message }) =>
    message.refusal != null && message.refusal !== "" && message.refusal !== false,
  );
}

export async function analyzeMessage({ message, apiKey, model, signal }: {
  message: string;
  apiKey: string;
  model: string;
  signal: AbortSignal;
}): Promise<Analysis> {
  signal.throwIfAborted();
  await requireStructuredOutput(model, signal);
  const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  let responseFailure: AnalysisErrorCode | undefined;
  try {
    const openrouter = createOpenRouter({ apiKey });
    const result = await generateText({
      model: openrouter.chat(model, {
        structuredOutputs: { strict: true },
        provider: { require_parameters: true },
      }),
      output: Output.object({ schema: analysisSchema, name: "studio_nova_analysis" }),
      instructions: `${STUDIO_NOVA_ANALYSIS_INSTRUCTIONS}\n\nCzas analizy: ${new Date().toISOString()}.`,
      messages: [{ role: "user", content: message }],
      abortSignal,
      maxRetries: 0,
      include: { responseBody: true },
      // Odrzucamy odmowę lub niedokończoną odpowiedź również wtedy, gdy zawiera poprawny JSON.
      // SDK ignoruje wyjątki z callbacków, dlatego zapisujemy stan i sprawdzamy go poza callbackiem.
      onStepEnd: ({ finishReason, response }) => {
        if (finishReason === "content-filter" || hasRefusal(response.body)) {
          responseFailure = "refused";
        } else if (finishReason !== "stop") responseFailure = "interrupted";
      },
    });
    abortSignal.throwIfAborted();
    if (responseFailure) throw new AnalysisError(responseFailure);
    const validated = analysisSchema.safeParse(result.output);
    if (!validated.success) throw new AnalysisError("invalid_output");
    return validated.data;
  } catch (error) {
    if (abortSignal.aborted) throw new AnalysisError("interrupted");
    if (responseFailure) throw new AnalysisError(responseFailure);
    if (error instanceof AnalysisError) throw error;
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new AnalysisError("invalid_output");
    }
    if (APICallError.isInstance(error)) {
      const detail = `${error.message} ${error.responseBody ?? ""}`;
      if ([400, 404, 422].includes(error.statusCode ?? 0) &&
        /structured.?output|response_format|json_schema|require_parameters|no endpoints found/i.test(detail)) {
        throw new AnalysisError("unsupported");
      }
    }
    // Bez surowej odpowiedzi, sekretów i treści rozmowy w komunikacie lub logach.
    throw new AnalysisError("provider");
  }
}
