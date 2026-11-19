import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig, sessionCookieName, validSession } from "../../lib/session";
import LoginForm from "../login-form";
import UploadForm from "./upload-form";

export default async function UploadPage() {
  const configured = Boolean(authConfig());
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!configured || !token || !await validSession(token)) return <LoginForm configured={configured} />;
  return <main className="chat">
    <h1>Baza wiedzy</h1>
    <Link href="/">Wróć do czatu</Link>
    <p>Wklej dokument. Każdy akapit (tekst oddzielony pustą linią) zostanie zapisany jako osobny fragment razem z embeddingiem do wyszukiwania.</p>
    <UploadForm />
  </main>;
}
