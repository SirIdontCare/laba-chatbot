import { requestUser } from "../../../lib/supabase-server";
import { sameOrigin } from "../../../lib/request-origin";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { editUserProfile, profileEditSchema } from "../../../lib/user-profile";

export async function PATCH(request: Request) {
  const user = await requestUser(request);
  if (!user) return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  if (!sameOrigin(request)) return new Response("Niedozwolone źródło.", { status: 403 });
  let input;
  try { input = profileEditSchema.safeParse(await request.json()); }
  catch { return new Response("Nieprawidłowe dane.", { status: 400 }); }
  if (!input.success) return new Response("Nieprawidłowe dane.", { status: 400 });
  try {
    await editUserProfile(user, input.data);
    return new Response(null, { status: 204 });
  } catch {
    return new Response("Nie udało się zmienić profilu. Sprawdź dane i spróbuj ponownie.", { status: 503 });
  }
}
