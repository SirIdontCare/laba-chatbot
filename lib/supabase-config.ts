// Publiczne dane projektu Supabase dla logowania (adres i klucz publishable).
// Next.js wstawia zmienne NEXT_PUBLIC_ do kodu przeglądarki podczas budowania.
export function supabaseAuthConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && key ? { url, key } : null;
}
