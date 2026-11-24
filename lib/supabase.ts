import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Klient z kluczem secret omija RLS. Służy wyłącznie do wspólnej bazy wiedzy
// (documents, chunks, match_chunks). Rozmowy i profil idą przez SignedInUser.db.
let supabase: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !key) {
    throw new Error("Skonfiguruj SUPABASE_URL i SUPABASE_SECRET_KEY na serwerze.");
  }

  supabase = createClient(url, key, {
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return supabase;
}
