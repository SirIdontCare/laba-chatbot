"use client";

import { useEffect } from "react";
import { createSupabaseBrowserClient } from "../lib/supabase-browser";
import { hidePageContent } from "../lib/page-privacy";

// Pilnuje, żeby po wylogowaniu nie zostały na ekranie dane poprzedniej osoby:
// - strona przywrócona przyciskiem „Wstecz” z pamięci przeglądarki (bfcache) jest
//   chowana i pobierana od nowa, więc serwer znów weryfikuje sesję;
// - wylogowanie w innej karcie chowa treść i przechodzi na /login.
export default function SessionGuard() {
  useEffect(() => {
    const reloadRestoredPage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      hidePageContent();
      window.location.reload();
    };
    window.addEventListener("pageshow", reloadRestoredPage);

    const supabase = createSupabaseBrowserClient();
    const subscription = supabase?.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT" || window.location.pathname === "/login") return;
      hidePageContent();
      window.location.replace("/login");
    }).data.subscription;

    return () => {
      window.removeEventListener("pageshow", reloadRestoredPage);
      subscription?.unsubscribe();
    };
  }, []);
  return null;
}
