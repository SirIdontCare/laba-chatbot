import "server-only";
import { checkRateLimit } from "@vercel/firewall";
import { AUTH_MESSAGES } from "./auth-messages";

// Tylko lokalny proces deweloperski. Nigdy nie służy do ochrony hostingu.
let localWindow = { started: 0, attempts: 0 };

export async function limitLogin() {
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1") {
    if (Date.now() - localWindow.started >= 60_000) {
      localWindow = { started: Date.now(), attempts: 0 };
    }
    localWindow.attempts++;
    if (localWindow.attempts > 5) {
      return new Response(AUTH_MESSAGES.limited, { status: 429, headers: { "Retry-After": "60" } });
    }
    return null;
  }

  // Produkcja wymaga wspólnej usługi. Brak reguły lub awaria blokują logowanie.
  // Adres produkcyjny jest publiczny. Techniczny VERCEL_URL może wymagać
  // logowania do Vercel i zwracać przekierowanie zamiast wyniku limitera.
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.NODE_ENV !== "production" || process.env.VERCEL !== "1" || !host || !/^[a-z0-9.-]+\.vercel\.app$/i.test(host)) {
    return new Response(AUTH_MESSAGES.limiter, { status: 503 });
  }
  try {
    const result = await checkRateLimit("workshop-login", {
      headers: { host }, // Bez przesyłania hasła, sesji i nagłówków użytkownika do limitera.
      rateLimitKey: "workshop-login", timeout: 2000,
    });
    if (result.error === "not-found") throw new Error("Missing rate limit");
    if (result.rateLimited) {
      return new Response(AUTH_MESSAGES.limited, { status: 429, headers: { "Retry-After": "60" } });
    }
    return null;
  } catch {
    return new Response(AUTH_MESSAGES.limiter, { status: 503 });
  }
}
