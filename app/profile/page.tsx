import { redirect } from "next/navigation";
import { loginPath } from "../../lib/redirect-target";
import { currentUser } from "../../lib/supabase-server";
import { loadUserProfile } from "../../lib/user-profile";
import UserMenu from "../user-menu";
import ProfileEditor from "./profile-editor";

export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect(loginPath("/profile"));
  const header = <header className="chat-header"><h1>Profil</h1><UserMenu email={user.email} /></header>;
  let profile;
  try { profile = await loadUserProfile(user); }
  catch { return <main className="chat">{header}<p role="alert">Nie udało się wczytać profilu. Odśwież stronę.</p><a href="/">Wróć do czatu</a></main>; }
  return <main className="chat">{header}<a href="/">Wróć do czatu</a><ProfileEditor profile={profile} /></main>;
}
