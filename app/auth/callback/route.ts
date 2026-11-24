import { NextResponse, type NextRequest } from "next/server";
import { loginPath, safeNextPath } from "../../../lib/redirect-target";
import { requestOrigin } from "../../../lib/request-origin";
import { createRedirectClient } from "../../../lib/supabase-server";

// Powrót od Google przez Supabase: wymiana kodu na sesję (PKCE), potem czat albo zapamiętana
// ścieżka tej aplikacji. Przy błędzie albo anulowaniu — /login z komunikatem po polsku.
// Supabase może podać błąd w parametrach (?error=access_denied) albo w części po „#”, której
// serwer nie widzi; przeglądarka przenosi ją przez przekierowanie na /login, a formularz ją odczytuje.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get("next"));
  const origin = requestOrigin(request);
  const toLogin = (reason: "google" | "google_cancelled") => {
    const url = new URL(loginPath(next), origin);
    url.searchParams.set("error", reason);
    return url;
  };

  const code = params.get("code");
  if (!code) return NextResponse.redirect(toLogin(params.get("error") === "access_denied" ? "google_cancelled" : "google"));

  const client = createRedirectClient(request);
  if (!client) return NextResponse.redirect(toLogin("google"));
  try {
    const { data, error } = await client.supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) return client.redirect(toLogin("google"));
    return client.redirect(new URL(next ?? "/", origin));
  } catch {
    return client.redirect(toLogin("google"));
  }
}
