"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHAT_ERRORS } from "../lib/chat-errors";
import { AUTH_MESSAGES } from "../lib/auth-messages";
import AnalysisPanel from "./analysis-panel";
import Link from "next/link";
import ThemeToggle from "./theme-toggle";
import { TOOL_LABELS } from "../lib/tool-catalog";
import { conversationForModel, markInterrupted, type ChatMessage } from "../lib/chat-message";
import { IMAGE_MESSAGES, isPhotoType, photoSelectionError } from "../lib/image-input";
import { imageToolInputSchema, imageToolOutputSchema, inspectionOutputSchema } from "../lib/image-tool-schema";

const transport = new DefaultChatTransport<ChatMessage>({
  api: "/api/agent",
  prepareSendMessagesRequest: ({ messages, body }) => ({
    body: { ...body, mode: "chat", messages: conversationForModel(messages) },
  }),
});
const retrievedAtFormat = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Warsaw",
});

function safeSourceUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function readPhoto(file: File): Promise<FileUIPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve({ type: "file", mediaType: file.type, filename: file.name, url: reader.result })
      : reject(new Error(IMAGE_MESSAGES.readPhoto));
    reader.onerror = () => reject(new Error(IMAGE_MESSAGES.readPhoto));
    reader.readAsDataURL(file);
  });
}

export default function ChatClient({ initialChat, historyError }: {
  initialChat: { id: string; messages: ChatMessage[] };
  historyError?: string;
}) {
  const chatId = useRef(initialChat.id);
  const [mode, setMode] = useState<"chat" | "analysis">("chat");
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [photo, setPhoto] = useState<FileUIPart>();
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [imageError, setImageError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const { messages, sendMessage, status, error, clearError, stop, setMessages } = useChat<ChatMessage>({
    transport,
    messages: initialChat.messages,
    generateId: () => crypto.randomUUID(),
    onError: (failure) => {
      if (failure.message === AUTH_MESSAGES.unauthorized) window.location.replace("/");
    },
  });
  const conversation = useRef<HTMLDivElement>(null);
  const agentWorking = status === "submitted" || status === "streaming" || generating;
  const waiting = agentWorking || readingPhoto || stopping;
  const imageInProgress = generating || messages.at(-1)?.parts.some((part) =>
    part.type === "tool-generujObraz" && (part.state === "input-streaming" || part.state === "input-available"));
  const errorMessage = [...Object.values(CHAT_ERRORS), IMAGE_MESSAGES.invalidPhoto].find(
    (text) => text === error?.message,
  ) ?? CHAT_ERRORS.unavailable;

  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, status, mode, generating]);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if ((!text && !photo) || waiting || leaving) return;

    clearError();
    setImageError("");
    const files = photo ? [photo] : undefined;
    setMessage("");
    setPhoto(undefined);
    try {
      await sendMessage({ text, files }, { body: { chatId: chatId.current } });
    } catch {
      setImageError(CHAT_ERRORS.unavailable);
    }
  }

  async function selectPhoto(file: File | undefined) {
    if (!file) return;
    setImageError("");
    setPhoto(undefined);
    const invalid = photoSelectionError(file);
    if (invalid) { setImageError(invalid); return; }
    setReadingPhoto(true);
    try {
      setPhoto(await readPhoto(file));
    } catch {
      setImageError(IMAGE_MESSAGES.readPhoto);
    } finally {
      setReadingPhoto(false);
    }
  }

  async function generatePicture() {
    const prompt = message.trim();
    if (waiting || leaving || photo) return;
    if (!prompt || prompt.length > 500) { setImageError(IMAGE_MESSAGES.invalidPrompt); return; }
    clearError();
    setImageError("");
    setGenerating(true);
    setMessage("");
    try {
      await sendMessage({ text: prompt }, { body: { intent: "image", chatId: chatId.current } });
    } catch {
      setImageError(IMAGE_MESSAGES.unavailable);
    } finally {
      setGenerating(false);
    }
  }

  function startNewChat() {
    chatId.current = crypto.randomUUID();
    setMessages([]);
    setMessage("");
    setPhoto(undefined);
    setImageError("");
    clearError();
    setMode("chat");
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

  async function stopTask() {
    if (!agentWorking || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      await stop();
      setMessages((current) => markInterrupted(current));
      clearError();
      setGenerating(false);
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✳</span>
          <div><p className="eyebrow">TWOJA PRZESTRZEŃ AI</p><h1>Mój chatbot</h1>
            <p className="header-description">Rozmawiaj, odkrywaj i twórz z pomocą AI.</p></div>
        </div>
        <div className="header-actions"><Link href="/dashboard">Podróże ↗</Link><ThemeToggle />
        <button className="secondary-button" type="button" onClick={logout} disabled={leaving}>
          {leaving ? "Wychodzę…" : "Wyjdź"}
        </button></div>
      </header>
      {logoutError && <p className="error" role="alert">{logoutError}</p>}
      <nav className="mode-switch" aria-label="Tryb pracy">
        <button type="button" aria-pressed={mode === "chat"} onClick={() => setMode("chat")} disabled={waiting || analysisBusy || leaving}>Zwykły czat</button>
        <button type="button" aria-pressed={mode === "analysis"} onClick={() => setMode("analysis")} disabled={waiting || analysisBusy || leaving}>Analiza JSON</button>
        <button type="button" className="secondary-button" onClick={startNewChat} disabled={waiting || analysisBusy || leaving}>Nowa rozmowa</button>
      </nav>
      {mode === "analysis" ? (
        <AnalysisPanel leaving={leaving} onBusyChange={setAnalysisBusy} />
      ) : (
        <>
          {historyError && <p className="error" role="alert">{historyError}</p>}
          <div ref={conversation} className="conversation" role="log" aria-label="Rozmowa" aria-live="polite" aria-busy={waiting}>
            {messages.length === 0 && (
              <div className="empty-conversation">
                <span className="welcome-mark" aria-hidden="true">✳</span>
                <p className="eyebrow">OD POMYSŁU DO ODPOWIEDZI</p>
                <h2>Od czego zaczynamy?</h2>
                <p>Zadaj pytanie, dodaj zdjęcie lub opisz obraz, który chcesz stworzyć.</p>
                <div className="welcome-tags" aria-hidden="true"><span>Rozmowa</span><span>Zdjęcia i obrazy</span><span>Źródła i narzędzia</span></div>
              </div>
            )}
            {messages.map((item) => {
              const sources = item.role === "assistant"
                ? item.parts.filter((part) => part.type === "source-url")
                  .filter((part, index, all) => safeSourceUrl(part.url) &&
                    all.findIndex((source) => source.url === part.url) === index)
                : [];
              const usedTools = Object.entries(TOOL_LABELS).filter(([name]) =>
                item.role === "assistant" && ((name === "web_search" && sources.length > 0) ||
                  item.parts.some((part) => part.type === `tool-${name}` &&
                    "state" in part && (part.state === "output-available" || part.state === "output-error"))));
              return (
              <div className={`message message--${item.role}`} key={item.id}>
                <strong>{item.role === "user" ? "Ty" : "Chatbot"}</strong>
                {item.role === "assistant" && !!item.metadata?.steps?.length && (
                  <ol className="agent-steps" aria-label="Kolejność kroków agenta">
                    {item.metadata.steps.map((step, index) => <li key={index}>{step.number}. {step.tool}</li>)}
                  </ol>
                )}
                {item.role === "assistant" && (item.metadata?.limitReached || item.metadata?.stoppedReason) && (
                  <section className="agent-limit" aria-label="Wynik po osiągnięciu limitu">
                    <p role="status">{item.metadata.stoppedReason || "Zatrzymałem się po 18 krokach"}</p>
                    <p>Dotychczasowe wyniki narzędzi:</p>
                    {item.metadata.partialResults?.length ? item.metadata.partialResults.map((result, index) => (
                      <details key={index} open><summary>{result.tool}</summary><pre>{result.text}</pre></details>
                    )) : <p>Nie otrzymałem wyników narzędzi. Nie mogę jeszcze potwierdzić ustaleń.</p>}
                  </section>
                )}
                {usedTools.length > 0 && (
                  <div className="tool-labels" aria-label="Użyte narzędzia">
                    {usedTools.map(([name, label]) => <span key={name}>{label}</span>)}
                  </div>
                )}
                {item.parts.map((part, index) => {
                  if (part.type === "text") return <span key={index}>{part.text}</span>;
                  if (part.type === "tool-obejrzyjObraz" && part.state === "output-available") {
                    const inspected = inspectionOutputSchema.safeParse(part.output);
                    if (!inspected.success) return null;
                    return (
                      <figure key={index} className="generated-figure">
                        <img className="chat-photo" src={inspected.data.url} alt="Obraz przekazany do vision" />
                        <figcaption><a href={inspected.data.url} target="_blank" rel="noopener noreferrer">Obraz przekazany do vision</a></figcaption>
                      </figure>
                    );
                  }
                  if (part.type === "tool-generujObraz" && part.state === "output-error") {
                    return <p key={index} className="error" role="alert">{IMAGE_MESSAGES.unavailable}</p>;
                  }
                  if (part.type === "tool-generujObraz" && part.state === "output-available") {
                    const parsed = imageToolOutputSchema.safeParse(part.output);
                    if (!parsed.success) return <p key={index} className="error" role="alert">{IMAGE_MESSAGES.unavailable}</p>;
                    const output = parsed.data;
                    if (!output.ok) return <p key={index} className="error" role="alert">{output.komunikat}</p>;
                    const imageInput = imageToolInputSchema.safeParse(part.input);
                    return (
                      <figure key={index} className="generated-figure">
                        <img className="generated-image" src={output.url} alt={imageInput.success ? imageInput.data.prompt : "Wygenerowany obraz"}
                          onLoad={() => {
                            const element = conversation.current;
                            if (element) element.scrollTop = element.scrollHeight;
                          }} />
                        <figcaption className="model-id">Model: {output.modelId || "API nie zwróciło identyfikatora modelu"}</figcaption>
                      </figure>
                    );
                  }
                  if (part.type === "file" && isPhotoType(part.mediaType)) return (
                    <img key={index} className={item.metadata?.kind === "image-generation" ? "generated-image" : "chat-photo"}
                      src={part.url} alt={part.filename || "Zdjęcie w rozmowie"} onLoad={() => {
                        const element = conversation.current;
                        if (element) element.scrollTop = element.scrollHeight;
                      }} />
                  );
                  return null;
                })}
                {item.metadata?.stats && <small className="model-id">Kroki: {item.metadata.stats.steps} · Wywołania narzędzi: {item.metadata.stats.toolCalls} · Czas: {(item.metadata.stats.elapsedMs / 1000).toFixed(1)} s</small>}
                {sources.length > 0 && (
                  <section className="sources" aria-label="Źródła">
                    <h2>Źródła</h2>
                    <ul>
                      {sources.map((source) => (
                        <li key={source.url}>
                          <a href={source.url} target="_blank" rel="noopener noreferrer">
                            {source.title?.trim() || source.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                    {item.metadata?.retrievedAt && (
                      <p>pobrano: <time dateTime={item.metadata.retrievedAt}>
                        {retrievedAtFormat.format(new Date(item.metadata.retrievedAt))}
                      </time> (Europe/Warsaw)</p>
                    )}
                  </section>
                )}
                {item.role === "assistant" && (item.metadata?.vision || item.metadata?.kind === "image-generation") && (
                  <small className="model-id">Model: {item.metadata.modelId || "API nie zwróciło identyfikatora modelu"}</small>
                )}
              </div>
              );
            })}
          </div>
          {waiting && (
            <p className="status" role="status">
              {imageInProgress ? "Generuję obraz…" : readingPhoto ? "Odczytuję zdjęcie…" : status === "submitted" ? "Czekam na odpowiedź…" : "Chatbot pisze…"}
            </p>
          )}
          {error && <p className="error" role="alert">{errorMessage}</p>}
          {imageError && <p className="error" role="alert">{imageError}</p>}
          <form className="message-form" onSubmit={submitMessage}>
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
              {agentWorking ? <button type="button" onClick={() => void stopTask()} disabled={stopping || leaving}>
                {stopping ? "Przerywam…" : "Stop"}
              </button> : <button type="submit" disabled={waiting || leaving || (!message.trim() && !photo)}>
                {waiting ? "Czekaj…" : "Wyślij"}
              </button>}
            </div>
            <div className="image-actions">
              <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden
                disabled={waiting || leaving} aria-label="Wybierz zdjęcie JPG, PNG lub WebP, do 4 MB"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void selectPhoto(file);
                }} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={waiting || leaving}>Dodaj zdjęcie</button>
              <button type="button" onClick={() => void generatePicture()}
                title={photo ? "Usuń zdjęcie, aby wygenerować obraz z opisu." : undefined}
                disabled={waiting || leaving || !message.trim() || !!photo}>Wygeneruj obraz</button>
            </div>
            <small className="image-hint">Zdjęcie: JPG, PNG lub WebP, do 4 MB. Opis do generowania: maks. 500 znaków.</small>
            {photo && (
              <div className="photo-preview">
                <img src={photo.url} alt="Wybrane zdjęcie" />
                <span>{photo.filename}</span>
                <button type="button" onClick={() => setPhoto(undefined)} disabled={waiting || leaving}>Usuń zdjęcie</button>
              </div>
            )}
          </form>
        </>
      )}
    </main>
  );
}
