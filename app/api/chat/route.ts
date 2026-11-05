import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type UIMessage,
} from "ai";
import { STUDIO_NOVA_CHAT_INSTRUCTIONS } from "../../../lib/studio-nova";
import { CHAT_ERRORS } from "../../../lib/chat-errors";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { requestToken, validSession, sameOrigin } from "../../../lib/session";


export async function POST(request: Request) {
  // Autoryzacja przed odczytem konfiguracji OpenRouter i uruchomieniem modelu.
  if (!(await validSession(requestToken(request)))) {
    return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  }
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  let messages: UIMessage[];

  try {
    const body = await request.json();
    messages = await validateUIMessages({ messages: body?.messages });

    const lastMessage = messages.at(-1);
    if (
      !messages.every(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          message.parts.every(
            (part) => part.type === "text" || part.type === "step-start",
          ),
      ) ||
      lastMessage?.role !== "user" ||
      !lastMessage.parts.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
      )
    ) {
      return new Response(CHAT_ERRORS.invalid, { status: 400 });
    }
  } catch {
    return new Response(CHAT_ERRORS.invalid, { status: 400 });
  }

  // Te zmienne są odczytywane wyłącznie w serwerowym endpointcie.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();

  if (!apiKey || !model) {
    return new Response(CHAT_ERRORS.configuration, { status: 503 });
  }

  try {
    const openrouter = createOpenRouter({ apiKey });
    // Pomijamy puste odpowiedzi pozostałe po przerwanym lub błędnym strumieniu.
    const history = messages.filter((message) =>
      message.parts.some((part) => part.type === "text" && part.text.trim()),
    );
    const result = streamText({
      model: openrouter(model),
      instructions: STUDIO_NOVA_CHAT_INSTRUCTIONS,
      messages: await convertToModelMessages(history),
      abortSignal: request.signal,
      maxRetries: 0,
      onError: () => {}, // Nie zapisujemy sekretów ani treści rozmowy w logach.
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        sendReasoning: false,
        onError: () => CHAT_ERRORS.unavailable,
      }),
    });
  } catch {
    return new Response(CHAT_ERRORS.unavailable, { status: 502 });
  }
}
