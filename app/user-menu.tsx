"use client";

import { useState } from "react";
import { AUTH_MESSAGES } from "../lib/auth-messages";
import { createSupabaseBrowserClient } from "../lib/supabase-browser";

// E-mail zalogowanej osoby i przycisk „Wyloguj”. E-mail pochodzi ze strony
// serwerowej, która zweryfikowała sesję.
export default function UserMenu({ email, onBeforeLogout, onLeavingChange }: {
  email: string | null;
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
      window.location.replace("/login");
    } catch {
      setError(AUTH_MESSAGES.logoutFailed);
      setLeaving(false);
    }
  }

  return (
    <div className="user-menu">
      {email && <span className="user-email" title={email}>{email}</span>}
      <button className="secondary-button" type="button" onClick={logout} disabled={leaving}>
        {leaving ? "Wylogowuję…" : "Wyloguj"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
