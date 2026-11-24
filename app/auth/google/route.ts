import { NextResponse, type NextRequest } from "next/server";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import { loginPath, safeNextPath } from "../../../lib/redirect-target";
import { requestOrigin, sameOrigin } from "../../../lib/request-origin";
import { createRedirectClient } from "../../../lib/supabase-server";

// Start logowania przez Google (PKCE po stronie serwera). Formularz z /login wysyła tu POST;
// serwer prosi Supabase o adres logowania u Google, zapisuje weryfikator PKCE w ciasteczku
// i przekierowuje przeglądarkę do Google. Client ID i Client Secret są tylko w panelu Supabase.
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  let form: FormData | null = null;
  try { form = await request.formData(); } catch { form = null; }
  // Tylko ścieżki wewnątrz aplikacji; wszystko inne kończy się powrotem na czat.
  const next = safeNextPath(form?.get("next"));
  const origin = requestOrigin(request);
  const failed = () => {
    const url = new URL(loginPath(next), origin);
    url.searchParams.set("error", "google");
    return NextResponse.redirect(url, 303);
  };

  const client = createRedirectClient(request);
  if (!client) return failed();
  // Adres powrotu z adresu, pod którym aplikacja właśnie działa (nie wpisany na sztywno).
  const callback = new URL("/auth/callback", origin);
  if (next) callback.searchParams.set("next", next);
  try {
    const { data, error } = await client.supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });
    if (error || !data.url) return failed();
    return client.redirect(data.url, 303);
  } catch {
    return failed();
  }
}
