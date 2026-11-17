import { requestToken, sameOrigin, validSession } from "../../../lib/session";
import { editUserProfile, profileEditSchema } from "../../../lib/user-profile";

export async function PATCH(request: Request) {
  const token = requestToken(request);
  if (!token || !await validSession(token)) return new Response("Zaloguj się ponownie.", { status: 401 });
  if (!sameOrigin(request)) return new Response("Niedozwolone źródło.", { status: 403 });
  let input;
  try { input = profileEditSchema.safeParse(await request.json()); }
  catch { return new Response("Nieprawidłowe dane.", { status: 400 }); }
  if (!input.success) return new Response("Nieprawidłowe dane.", { status: 400 });
  try {
    await editUserProfile(input.data);
    return new Response(null, { status: 204 });
  } catch {
    return new Response("Nie udało się zmienić profilu. Sprawdź dane i spróbuj ponownie.", { status: 503 });
  }
}
