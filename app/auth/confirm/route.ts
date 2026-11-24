import { NextResponse, type NextRequest } from "next/server";
import { createRouteClient } from "../../../lib/supabase-server";

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
  const target = request.nextUrl.clone();
  target.search = "";
  target.pathname = confirmed ? "/" : "/login";
  if (!confirmed) target.searchParams.set("error", "confirm");
  return NextResponse.redirect(target);
}
