// Ochrona przed żądaniami z obcych stron (CSRF): przyjmujemy tylko własne źródło.
export function sameOrigin(request: Request) {
  try {
    const target = new URL(request.url);
    // Next.js normalizuje adres URL 127.0.0.1 do localhost. Host zachowuje
    // rzeczywisty adres przeglądarki. Nie ufamy X-Forwarded-Host od klienta.
    const host = request.headers.get("host");
    const expected = host ? new URL(`${target.protocol}//${host}`).origin : target.origin;
    return request.headers.get("origin") === expected;
  } catch {
    return false;
  }
}
