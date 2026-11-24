import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAuthConfig } from "./supabase-config";
import { loginPath, safeNextPath } from "./redirect-target";

// Strony dostępne bez logowania. /auth/confirm kończy potwierdzenie adresu e-mail.
const isPublicPath = (path: string) => path === "/login" || path.startsWith("/auth/");

// `target` to ścieżka tej aplikacji, np. "/login?next=%2Fupload".
function redirectWithSession(request: NextRequest, target: string, from: NextResponse) {
  const parsed = new URL(target, "http://app.invalid");
  const url = request.nextUrl.clone();
  url.pathname = parsed.pathname;
  url.search = parsed.search;
  url.hash = "";
  const redirect = NextResponse.redirect(url);
  // Odświeżone lub usunięte ciasteczka sesji i nagłówki zakazu cache muszą przejść dalej.
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(header);
    if (value) redirect.headers.set(header, value);
  }
  return redirect;
}

// Odświeża wygasający token i zapisuje go w ciasteczkach (komponenty serwerowe
// nie mogą tego zrobić). Przekierowanie jest tylko wstępnym sprawdzeniem:
// każda strona i każdy endpoint weryfikuje użytkownika ponownie na serwerze.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  let signedIn = false;
  const config = supabaseAuthConfig();
  if (config) {
    const supabase = createServerClient(config.url, config.key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    });
    // Bez żadnego kodu między createServerClient a getClaims(): to wywołanie odświeża sesję.
    try {
      const { data } = await supabase.auth.getClaims();
      const claims = data?.claims;
      signedIn = Boolean(claims?.sub && claims.role === "authenticated" && !claims.is_anonymous);
    } catch {
      signedIn = false;
    }
  }

  const path = request.nextUrl.pathname;
  // Endpointy API same zwracają 401, więc nie przekierowujemy ich na stronę logowania.
  if (path.startsWith("/api/")) return response;
  // Niezalogowany: zapamiętujemy, dokąd chciał wejść, i po zalogowaniu tam wracamy.
  if (!signedIn && !isPublicPath(path)) {
    return redirectWithSession(request, loginPath(path + request.nextUrl.search), response);
  }
  if (signedIn && path === "/login") {
    return redirectWithSession(request, safeNextPath(request.nextUrl.searchParams.get("next")) ?? "/", response);
  }
  return response;
}
