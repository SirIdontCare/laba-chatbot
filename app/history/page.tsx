import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig, sessionCookieName, validSession } from "../../lib/session";
import { listChats } from "../../lib/chat-history";
import LoginForm from "../login-form";

export default async function HistoryPage() {
  const configured = Boolean(authConfig());
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!configured || !token || !await validSession(token)) {
    return <LoginForm configured={configured} />;
  }
  let chats;
  try {
    chats = await listChats(token);
  } catch {
    return <main className="chat"><h1>Historia</h1><p role="alert">Nie udało się wczytać historii. Odśwież stronę.</p><Link href="/">Wróć do czatu</Link></main>;
  }
  const format = new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw",
  });
  return (
    <main className="chat">
      <header className="chat-header"><h1>Historia</h1><a className="secondary-button" href="/?new=1">Nowa rozmowa</a></header>
      <Link href="/">Wróć do czatu</Link>
      {chats.length === 0 ? <p>Nie masz jeszcze zapisanych rozmów.</p> : (
        <ul className="history-list">
          {chats.map(chat => (
            <li key={chat.chat_id}>
              <Link href={`/?chat=${chat.chat_id}`}>
                <strong>{chat.title || "Rozmowa"}</strong>
                <span><time dateTime={chat.created_at}>{format.format(new Date(chat.created_at))}</time> · Wiadomości {chat.messages[0]?.count ?? 0}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
