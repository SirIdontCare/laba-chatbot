import { NextResponse, type NextRequest } from "next/server";
import { createRouteClient } from "../../../lib/supabase-server";
import { loginPath, safeNextPath } from "../../../lib/redirect-target";

// Link z e-maila potwierdzającego konto. Obsługuje token_hash (szablon z dokumentacji
// Supabase SSR) oraz code (domyślny przepływ PKCE). Przekierowuje tylko na stałe
// adresy tej aplikacji, nigdy na adres z parametru.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const code = params.get("code");
  let confirmed = false;
  try {
    const supabase = await createRouteClient();
    if (supabase && tokenHash && (type === "signup" || type === "email")) {
      confirmed = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
    } else if (supabase && code) {
      confirmed = !(await supabase.auth.exchangeCodeForSession(code)).error;
    }
  } catch {
    confirmed = false;
  }
  const next = safeNextPath(params.get("next"));
  const path = new URL(confirmed ? next ?? "/" : loginPath(next), "http://app.invalid");
  const target = request.nextUrl.clone();
  target.pathname = path.pathname;
  target.search = path.search;
  target.hash = "";
  if (!confirmed) target.searchParams.set("error", "confirm");
  return NextResponse.redirect(target);
}
