// Adres, pod którym aplikacja właśnie działa, z punktu widzenia przeglądarki.
// Next.js normalizuje adres URL 127.0.0.1 do localhost; nagłówek Host zachowuje
// rzeczywisty adres przeglądarki. Nie ufamy X-Forwarded-Host od klienta.
export function requestOrigin(request: Request) {
  const target = new URL(request.url);
  const host = request.headers.get("host");
  return host ? new URL(`${target.protocol}//${host}`).origin : target.origin;
}

// Ochrona przed żądaniami z obcych stron (CSRF): przyjmujemy tylko własne źródło.
export function sameOrigin(request: Request) {
  try {
    return request.headers.get("origin") === requestOrigin(request);
  } catch {
    return false;
  }
}
