import { cookies } from "next/headers";
import { authConfig, sessionCookieName, validSession } from "../../lib/session";
import { loadUserProfile } from "../../lib/user-profile";
import LoginForm from "../login-form";
import ProfileEditor from "./profile-editor";

export default async function ProfilePage() {
  const configured = Boolean(authConfig());
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!configured || !token || !await validSession(token)) return <LoginForm configured={configured} />;
  let profile;
  try { profile = await loadUserProfile(); }
  catch { return <main className="chat"><h1>Profil</h1><p role="alert">Nie udało się wczytać profilu. Odśwież stronę.</p><a href="/">Wróć do czatu</a></main>; }
  return <main className="chat"><h1>Profil</h1><a href="/">Wróć do czatu</a><ProfileEditor profile={profile} /></main>;
}
