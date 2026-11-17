import { z } from "zod";
import { requestToken, validSession, sameOrigin } from "../../../lib/session";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { agentChat } from "../../../lib/agent-chat";
import { agentAnalyze, analysisFailure } from "../../../lib/agent-analyze";

export const maxDuration = 120;
const chatSchema = z.strictObject({
  mode: z.literal("chat"), messages: z.unknown(), intent: z.literal("image").optional(), chatId: z.uuid().optional(),
});

export async function POST(request: Request) {
  // Wspólna bramka: przed odczytem JSON, konfiguracji i każdym modelem/narzędziem.
  const token = requestToken(request);
  if (!token || !(await validSession(token))) {
    return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  }
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return analysisFailure(request.signal.aborted ? "interrupted" : "input", 400);
  }
  if (!body || typeof body !== "object" || !("mode" in body)) {
    return new Response("Wybierz tryb chat lub analyze.", { status: 400 });
  }
  if (body.mode === "analyze") {
    const { mode: _mode, ...input } = body;
    return agentAnalyze(request, input);
  }
  if (body.mode === "chat") {
    const input = chatSchema.safeParse(body);
    if (!input.success) return new Response("Nieprawidłowe dane rozmowy.", { status: 400 });
    return agentChat(request, input.data, token);
  }
  return new Response("Wybierz tryb chat lub analyze.", { status: 400 });
}
