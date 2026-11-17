"use client";

import { useState, type FormEvent } from "react";
import { AUTH_MESSAGES } from "../lib/auth-messages";
import ThemeToggle from "./theme-toggle";

export default function LoginForm({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || pending || !password.trim()) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setPassword("");
      if (response.ok) {
        window.location.replace("/");
        return;
      }
      const text = await response.text();
      setError(Object.values(AUTH_MESSAGES).find((message) => message === text) ?? AUTH_MESSAGES.network);
    } catch {
      setError(AUTH_MESSAGES.network);
    }
    setPending(false);
  }

  return (
    <main className="chat login">
      <header className="login-header"><span className="brand-mark" aria-hidden="true">✳</span><ThemeToggle /></header>
      <p className="eyebrow">TWOJA PRZESTRZEŃ AI</p>
      <h1>Mój chatbot</h1>
      <p className="login-description">Rozmawiaj, odkrywaj i twórz z pomocą AI.</p>
      <h2>Witaj z powrotem</h2>
      <p className="login-description">Wpisz hasło warsztatowe, aby rozpocząć.</p>
      {!configured && <p className="error" role="alert">{AUTH_MESSAGES.configuration}</p>}
      <form onSubmit={login}>
        <label htmlFor="password">Hasło warsztatowe</label>
        <div className="composer">
          <input id="password" name="password" type="password" autoComplete="current-password"
            value={password} onChange={(event) => setPassword(event.target.value)}
            disabled={pending || !configured} required />
          <button type="submit" disabled={pending || !configured || !password.trim()}>
            {pending ? "Sprawdzam…" : "Wejdź"}
          </button>
        </div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
