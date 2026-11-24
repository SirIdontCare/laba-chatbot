import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient, parseCookieHeader, type CookieOptions } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { supabaseAuthConfig } from "./supabase-config";
import { accountFromClaims, type AccountSummary } from "./account";

// Tożsamość ustala wyłącznie serwer: z podpisanego tokenu Supabase zweryfikowanego
// przez getClaims(), nigdy z formularza, adresu strony ani odpowiedzi modelu.
export type SignedInUser = {
  id: string;
  email: string | null;
  sessionId: string | null;
  // Imię i avatar do nagłówka (np. z konta Google). Tylko do wyświetlania.
  account: AccountSummary;
  // Baza danych jako ta osoba: klucz publishable + token z jej zweryfikowanej sesji.
  // Każde zapytanie przechodzi przez RLS, więc baza pokazuje i zmienia tylko jej wiersze.
  db: SupabaseClient;
  // Ponowna weryfikacja tego samego tokenu (bez odświeżania sesji),
  // np. przed zapisem po długiej odpowiedzi modelu.
  stillSignedIn: () => Promise<boolean>;
};

type CookieList = { name: string; value: string }[];

async function writeCookies(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
  try {
    const store = await cookies();
    for (const { name, value, options } of cookiesToSet) store.set(name, value, options);
  } catch {
    // Komponent serwerowy nie może zapisywać ciasteczek. Sesję odświeża proxy.ts.
  }
}

type AuthConfig = NonNullable<ReturnType<typeof supabaseAuthConfig>>;

function createClient(readCookies: () => CookieList) {
  const config = supabaseAuthConfig();
  if (!config) return null;
  // Nowy klient dla każdego żądania. Nie współdzielimy go między użytkownikami.
  return {
    config,
    supabase: createServerClient(config.url, config.key, {
      cookies: { getAll: readCookies, setAll: writeCookies },
    }),
  };
}

// Klient bazy z tokenem już zweryfikowanej sesji. Nie odświeża sesji w tle: gdy token
// wygaśnie w trakcie długiej odpowiedzi, zapis się nie uda, zamiast zużyć refresh token
// bez możliwości zapisania nowych ciasteczek.
function userDatabase(config: AuthConfig, accessToken: string) {
  return createSupabaseClient(config.url, config.key, {
    accessToken: async () => accessToken,
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

async function verify(client: ReturnType<typeof createClient>): Promise<SignedInUser | null> {
  if (!client) return null;
  const { config, supabase } = client;
  try {
    // getClaims() sprawdza podpis i ważność tokenu (lokalnie kluczem JWKS albo
    // zapytaniem do Supabase Auth). Samo odczytanie ciasteczka nie wystarcza.
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (error || !claims?.sub || claims.role !== "authenticated" || claims.is_anonymous) return null;
    // Token z już zweryfikowanej sesji służy tylko do ponownej weryfikacji.
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) return null;
    const userId = claims.sub;
    const email = typeof claims.email === "string" && claims.email ? claims.email : null;
    return {
      id: userId,
      email,
      account: accountFromClaims(email, claims.user_metadata),
      sessionId: typeof claims.session_id === "string" ? claims.session_id : null,
      db: userDatabase(config, accessToken),
      stillSignedIn: async () => {
        try {
          const again = await supabase.auth.getClaims(accessToken);
          return !again.error && again.data?.claims.sub === userId;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
}

// Strony i komponenty serwerowe. cookies() zawsze przełącza stronę na renderowanie
// dynamiczne, także gdy brakuje konfiguracji Supabase.
export const currentUser = cache(async (): Promise<SignedInUser | null> => {
  const store = await cookies();
  return verify(createClient(() => store.getAll()));
});

// Route Handlery: ciasteczka z bieżącego żądania. Odświeżoną sesję zapisuje cookies().
export async function requestUser(request: Request): Promise<SignedInUser | null> {
  return verify(createClient(() => parseCookieHeader(request.headers.get("cookie") ?? "")));
}

// Route Handler zakończony przekierowaniem (start logowania Google, /auth/callback):
// ciasteczka czytamy z żądania, a nowe (weryfikator PKCE, sesja po wymianie kodu)
// dokładamy do odpowiedzi przekierowania razem z nagłówkami zakazu cache.
export function createRedirectClient(request: Request) {
  const config = supabaseAuthConfig();
  if (!config) return null;
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const headers: Record<string, string> = {};
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get("cookie") ?? ""),
      setAll(cookiesToSet, cacheHeaders) {
        pending.push(...cookiesToSet);
        Object.assign(headers, cacheHeaders);
      },
    },
  });
  return {
    supabase,
    redirect(url: string | URL, status = 307) {
      const response = NextResponse.redirect(url, status);
      for (const { name, value, options } of pending) response.cookies.set(name, value, options);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    },
  };
}

// Klient do zakończenia logowania w Route Handlerze (np. potwierdzenie e-maila).
export async function createRouteClient() {
  const store = await cookies();
  return createClient(() => store.getAll())?.supabase ?? null;
}
