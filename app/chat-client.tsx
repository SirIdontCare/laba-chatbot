"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHAT_ERRORS } from "../lib/chat-errors";
import { AUTH_MESSAGES } from "../lib/auth-messages";
import AnalysisPanel from "./analysis-panel";

const transport = new DefaultChatTransport({ api: "/api/chat" });

export default function ChatClient() {
  const [mode, setMode] = useState<"chat" | "analysis">("chat");
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const { messages, sendMessage, status, error, clearError, stop, setMessages } = useChat({
    transport,
    onError: (failure) => {
      if (failure.message === AUTH_MESSAGES.unauthorized) window.location.replace("/");
    },
  });
  const conversation = useRef<HTMLDivElement>(null);
  const waiting = status === "submitted" || status === "streaming";
  const errorMessage = Object.values(CHAT_ERRORS).find(
    (text) => text === error?.message,
  ) ?? CHAT_ERRORS.unavailable;

  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, status, mode]);

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || waiting || leaving) return;

    clearError();
    void sendMessage({ text });
    setMessage("");
  }

  async function logout() {
    setLeaving(true);
    setLogoutError("");
    try {
      await stop();
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      setMessages([]);
      window.location.replace("/");
    } catch {
      setLogoutError("Nie udało się wyjść. Spróbuj ponownie.");
      setLeaving(false);
    }
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <h1>Mój chatbot</h1>
        <button type="button" onClick={logout} disabled={leaving}>
          {leaving ? "Wychodzę…" : "Wyjdź"}
        </button>
      </header>
      {logoutError && <p className="error" role="alert">{logoutError}</p>}
      <nav className="mode-switch" aria-label="Tryb pracy">
        <button type="button" aria-pressed={mode === "chat"} onClick={() => setMode("chat")} disabled={waiting || analysisBusy || leaving}>Zwykły czat</button>
        <button type="button" aria-pressed={mode === "analysis"} onClick={() => setMode("analysis")} disabled={waiting || analysisBusy || leaving}>Analiza wiadomości</button>
      </nav>
      {mode === "analysis" ? (
        <AnalysisPanel leaving={leaving} onBusyChange={setAnalysisBusy} />
      ) : (
        <>
          <div ref={conversation} className="conversation" role="log" aria-label="Rozmowa" aria-live="polite" aria-busy={waiting}>
            {messages.map((item) => (
              <div className={`message message--${item.role}`} key={item.id}>
                <strong>{item.role === "user" ? "Ty" : "Chatbot"}</strong>
                {item.parts.map((part, index) =>
                  part.type === "text" ? <span key={index}>{part.text}</span> : null,
                )}
              </div>
            ))}
          </div>
          {waiting && (
            <p className="status" role="status">
              {status === "submitted" ? "Czekam na odpowiedź…" : "Chatbot pisze…"}
            </p>
          )}
          {error && <p className="error" role="alert">{errorMessage}</p>}
          <form onSubmit={submitMessage}>
            <label htmlFor="message">Wiadomość</label>
            <div className="composer">
              <input
                id="message"
                name="message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Napisz wiadomość…"
                autoComplete="off"
                disabled={waiting || leaving}
              />
              <button type="submit" disabled={waiting || leaving || !message.trim()}>
                {waiting ? "Czekaj…" : "Wyślij"}
              </button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}
