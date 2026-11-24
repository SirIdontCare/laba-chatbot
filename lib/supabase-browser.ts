import { createBrowserClient } from "@supabase/ssr";
import { supabaseAuthConfig } from "./supabase-config";

// Klient Supabase dla komponentów klienckich. Sesję zapisuje w ciasteczkach,
// aby serwer mógł ją zweryfikować. W przeglądarce jest jeden wspólny egzemplarz.
export function createSupabaseBrowserClient() {
  const config = supabaseAuthConfig();
  return config ? createBrowserClient(config.url, config.key) : null;
}
