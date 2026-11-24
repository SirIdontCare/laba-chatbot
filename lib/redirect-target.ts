// Dokąd wrócić po zalogowaniu. Przyjmujemy wyłącznie ścieżki wewnątrz tej aplikacji:
// adresy innych stron (np. //evil.example, /\evil.example, https://...) są odrzucane.
const INTERNAL = "http://app.invalid";

export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 2048) return null;
  try {
    const url = new URL(value, INTERNAL);
    if (url.origin !== INTERNAL) return null;
    const path = url.pathname;
    if (path === "/login" || path.startsWith("/login/") || path.startsWith("/auth/") ||
        path.startsWith("/api/") || path.startsWith("/_next/")) return null;
    return `${path}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

// Adres strony logowania, który po zalogowaniu wraca do `next` (gdy jest bezpieczny).
export function loginPath(next?: string | null) {
  const target = safeNextPath(next);
  return target && target !== "/" ? `/login?next=${encodeURIComponent(target)}` : "/login";
}
