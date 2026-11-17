import { z } from "zod";
import { requestToken, validSession, sameOrigin } from "../../../lib/session";
import { deleteChat } from "../../../lib/chat-history";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";

export async function DELETE(request: Request) {
  const token = requestToken(request);
  if (!token || !await validSession(token)) return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  const input = z.uuid().safeParse(new URL(request.url).searchParams.get("chat"));
  if (!input.success) return new Response("Nieprawidłowa rozmowa.", { status: 400 });
  try {
    await deleteChat(token, input.data);
    return new Response(null, { status: 204 });
  } catch {
    return new Response("Nie udało się usunąć rozmowy. Spróbuj ponownie.", { status: 503 });
  }
}
