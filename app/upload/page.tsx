import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig, sessionCookieName, validSession } from "../../lib/session";
import { listDocuments } from "../../lib/knowledge-base";
import LoginForm from "../login-form";
import UploadForm from "./upload-form";
import DeleteDocumentButton from "./delete-document-button";

function fragmentWord(count: number) {
  if (count === 1) return "fragment";
  const last = count % 10, lastTwo = count % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "fragmenty" : "fragmentów";
}

export default async function UploadPage() {
  const configured = Boolean(authConfig());
  const token = (await cookies()).get(sessionCookieName())?.value;
  // Lista dokumentów dopiero po sprawdzeniu sesji.
  if (!configured || !token || !await validSession(token)) return <LoginForm configured={configured} />;
  let documents;
  try { documents = await listDocuments(); } catch { documents = null; }
  const format = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw" });
  return <main className="chat">
    <h1>Baza wiedzy</h1>
    <Link href="/">Wróć do czatu</Link>
    <p>Wklej dokument. Każdy akapit (tekst oddzielony pustą linią) zostanie zapisany jako osobny fragment razem z embeddingiem do wyszukiwania.
      Dokument o tytule, który już jest w bazie, zastąpi poprzednią wersję (zapytam o potwierdzenie).</p>
    <UploadForm />
    <h2>Dokumenty w bazie</h2>
    {documents === null ? <p role="alert" className="error">Nie udało się wczytać listy dokumentów. Odśwież stronę.</p>
      : documents.length === 0 ? <p>Baza wiedzy jest pusta. Dodaj pierwszy dokument powyżej.</p>
      : <ul className="history-list document-list">
        {documents.map(doc => <li key={doc.id}>
          <div>
            <strong>{doc.title}</strong>
            <span>Wersja z <time dateTime={doc.created_at}>{format.format(new Date(doc.created_at))}</time> · {doc.chunks} {fragmentWord(doc.chunks)}</span>
          </div>
          <DeleteDocumentButton documentId={doc.id} title={doc.title} />
        </li>)}
      </ul>}
  </main>;
}
