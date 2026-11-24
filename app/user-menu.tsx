"use client";

import { useState } from "react";
import { AUTH_MESSAGES } from "../lib/auth-messages";
import { createSupabaseBrowserClient } from "../lib/supabase-browser";
import { hidePageContent } from "../lib/page-privacy";
import type { AccountSummary } from "../lib/account";

// Imię (lub e-mail), avatar zalogowanej osoby i przycisk „Wyloguj”. Dane pochodzą ze strony
// serwerowej, która zweryfikowała sesję.
export default function UserMenu({ account, onBeforeLogout, onLeavingChange }: {
  account: AccountSummary;
  onBeforeLogout?: () => Promise<void> | void;
  onLeavingChange?: (leaving: boolean) => void;
}) {
  const [leaving, setLeavingState] = useState(false);
  const [error, setError] = useState("");
  const setLeaving = (value: boolean) => {
    setLeavingState(value);
    onLeavingChange?.(value);
  };

  async function logout() {
    setLeaving(true);
    setError("");
    try {
      await onBeforeLogout?.();
      const supabase = createSupabaseBrowserClient();
      if (supabase) {
        // Kończy sesję tego urządzenia w Supabase i usuwa ciasteczka.
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        if (signOutError) throw signOutError;
      }
      // Dane poprzedniej osoby znikają z ekranu od razu, jeszcze przed przejściem na /login.
      hidePageContent();
      window.location.replace("/login");
    } catch {
      setError(AUTH_MESSAGES.logoutFailed);
      setLeaving(false);
    }
  }

  return (
    <div className="user-menu">
      <span className="user-identity" title={account.email ?? undefined}>
        {/* Zwykły img: adres https z konta Google; bez wysyłania adresu strony (referrer). */}
        {account.avatarUrl && <img className="user-avatar" src={account.avatarUrl} alt="" width={28} height={28} referrerPolicy="no-referrer" />}
        {(account.name ?? account.email) && <span className="user-email">{account.name ?? account.email}</span>}
      </span>
      <button className="secondary-button" type="button" onClick={logout} disabled={leaving}>
        {leaving ? "Wylogowuję…" : "Wyloguj"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
