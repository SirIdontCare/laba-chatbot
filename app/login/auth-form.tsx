"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AUTH_MESSAGES, MIN_PASSWORD_LENGTH, authErrorMessage, oauthHashErrorMessage } from "../../lib/auth-messages";
import { createSupabaseBrowserClient } from "../../lib/supabase-browser";
import ThemeToggle from "../theme-toggle";

type Mode = "login" | "signup";

export default function AuthForm({ configured, initialError, next }: {
  configured: boolean;
  // Komunikat po nieudanym potwierdzeniu e-maila albo logowaniu Google (z serwera).
  initialError: string;
  // Bezpieczna ścieżka tej aplikacji (sprawdzona na serwerze) albo null.
  next: string | null;
}) {
  const destination = next ?? "/";
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  // Blokada także dla szybkiego podwójnego kliknięcia, zanim React odświeży przycisk.
  const busy = useRef(false);
  const [error, setError] = useState(initialError);
  const [info, setInfo] = useState("");
  const [googlePending, setGooglePending] = useState(false);

  // Błąd od Google/Supabase może przyjść w części adresu po „#” (serwer jej nie widzi).
  useEffect(() => {
    const message = oauthHashErrorMessage(window.location.hash);
    if (!message) return;
    setError(message);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setInfo("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    setError("");
    setInfo("");
    const address = email.trim();
    if (!address) return setError(AUTH_MESSAGES.invalidEmail);
    if (mode === "signup" && password.length < MIN_PASSWORD_LENGTH) return setError(AUTH_MESSAGES.passwordTooShort);
    if (!password) return setError(AUTH_MESSAGES.checkInput);
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return setError(AUTH_MESSAGES.configuration);

    busy.current = true;
    setPending(true);
    try {
      if (mode === "login") {
        const { error: loginError } = await supabase.auth.signInWithPassword({ email: address, password });
        if (loginError) throw loginError;
        window.location.replace(destination);
        return;
      }
      const { data, error: signupError } = await supabase.auth.signUp({
        email: address, password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/confirm${next ? `?next=${encodeURIComponent(next)}` : ""}`,
        },
      });
      if (signupError) throw signupError;
      // Przy włączonym potwierdzaniu e-maili Supabase nie zgłasza błędu dla istniejącego
      // konta, tylko zwraca użytkownika bez tożsamości.
      if (data.user && data.user.identities?.length === 0) {
        setError(AUTH_MESSAGES.accountExists);
      } else if (data.session) {
        window.location.replace(destination);
        return;
      } else {
        setInfo(AUTH_MESSAGES.confirmEmail);
        setMode("login");
      }
    } catch (failure) {
      setError(authErrorMessage(failure as Parameters<typeof authErrorMessage>[0]));
    }
    setPassword("");
    busy.current = false;
    setPending(false);
  }

  const signup = mode === "signup";
  const busyAny = pending || googlePending;
  return (
    <main className="chat login">
      <header className="login-header"><span className="brand-mark" aria-hidden="true">✳</span><ThemeToggle /></header>
      <p className="eyebrow">TWOJA PRZESTRZEŃ AI</p>
      <h1>Mój chatbot</h1>
      <p className="login-description">Rozmawiaj, odkrywaj i twórz z pomocą AI.</p>
      <nav className="mode-switch auth-tabs" aria-label="Logowanie lub rejestracja">
        <button type="button" aria-pressed={!signup} onClick={() => switchMode("login")} disabled={busyAny}>Zaloguj się</button>
        <button type="button" aria-pressed={signup} onClick={() => switchMode("signup")} disabled={busyAny}>Załóż konto</button>
      </nav>
      <h2>{signup ? "Załóż konto" : "Witaj z powrotem"}</h2>
      <p className="login-description">
        {signup ? `Podaj e-mail i hasło (co najmniej ${MIN_PASSWORD_LENGTH} znaków).` : "Zaloguj się e-mailem i hasłem."}
      </p>
      {!configured && <p className="error" role="alert">{AUTH_MESSAGES.configuration}</p>}
      {/* Start logowania Google na serwerze (POST /auth/google), bez kluczy dostawcy w kodzie. */}
      <form method="post" action="/auth/google" className="google-login" onSubmit={(event) => {
        if (busyAny || !configured) { event.preventDefault(); return; }
        setError("");
        setGooglePending(true);
      }}>
        {next && <input type="hidden" name="next" value={next} />}
        <button type="submit" className="secondary-button" disabled={busyAny || !configured} aria-busy={googlePending}>
          {googlePending ? "Chwileczkę…" : "Zaloguj przez Google"}
        </button>
      </form>
      <p className="auth-divider" aria-hidden="true"><span>albo e-mailem</span></p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="email">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="email" inputMode="email"
          value={email} onChange={(event) => setEmail(event.target.value)}
          disabled={busyAny || !configured} required />
        <label htmlFor="password" className="auth-password-label">Hasło</label>
        <div className="composer">
          <input id="password" name="password" type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            minLength={signup ? MIN_PASSWORD_LENGTH : undefined}
            value={password} onChange={(event) => setPassword(event.target.value)}
            disabled={busyAny || !configured} required />
          <button type="submit" disabled={busyAny || !configured || !email.trim() || !password} aria-busy={pending}>
            {pending ? "Chwileczkę…" : (signup ? "Załóż konto" : "Zaloguj się")}
          </button>
        </div>
      </form>
      {info && <p className="notice" role="status">{info}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
