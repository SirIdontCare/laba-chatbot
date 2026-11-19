import { requestToken, sameOrigin, validSession } from "../../../lib/session";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { KB_MESSAGES, KnowledgeBaseError, saveDocument, uploadSchema } from "../../../lib/knowledge-base";

export async function POST(request: Request) {
  // Bramka sesji przed odczytem danych i przed bazą.
  const token = requestToken(request);
  if (!token || !await validSession(token)) return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  let input;
  try { input = uploadSchema.safeParse(await request.json()); }
  catch { return new Response("Nieprawidłowe dane formularza.", { status: 400 }); }
  if (!input.success) {
    return new Response("Uzupełnij tytuł (do 200 znaków) i treść (do 20 000 znaków).", { status: 400 });
  }
  try {
    return Response.json(await saveDocument(input.data));
  } catch (error) {
    return new Response(error instanceof KnowledgeBaseError ? error.message : KB_MESSAGES.document, { status: 503 });
  }
}
