import Link from "next/link";
import { redirect } from "next/navigation";
import { loginPath } from "../../lib/redirect-target";
import { currentUser } from "../../lib/supabase-server";
import { listChats } from "../../lib/chat-history";
import UserMenu from "../user-menu";
import DeleteChatButton from "./delete-chat-button";

export default async function HistoryPage() {
  const user = await currentUser();
  if (!user) redirect(loginPath("/history"));
  let chats;
  try {
    chats = await listChats(user);
  } catch {
    return <main className="chat"><h1>Historia</h1><p role="alert">Nie udało się wczytać historii. Odśwież stronę.</p><Link href="/">Wróć do czatu</Link></main>;
  }
  const format = new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw",
  });
  return (
    <main className="chat">
      <header className="chat-header"><h1>Historia</h1><div className="header-actions"><a className="secondary-button" href="/?new=1">Nowa rozmowa</a><UserMenu email={user.email} /></div></header>
      <Link href="/">Wróć do czatu</Link>
      {chats.length === 0 ? <p>Od czego zaczynamy? Zadaj pytanie lub opisz zadanie — pomogę Ci znaleźć informacje i przejść do działania. Wybierz „Nowa rozmowa”.</p> : (
        <ul className="history-list">
          {chats.map(chat => (
            <li key={chat.chat_id}>
              <a href={`/?chat=${chat.chat_id}`}>
                <strong>{chat.title || "Rozmowa"}</strong>
                <span><time dateTime={chat.created_at}>{format.format(new Date(chat.created_at))}</time> · Wiadomości {chat.messages[0]?.count ?? 0}</span>
              </a>
              <DeleteChatButton chatId={chat.chat_id} title={chat.title || "Rozmowa"} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
