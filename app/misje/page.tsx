import { redirect } from "next/navigation";
import { loginPath } from "../../lib/redirect-target";
import { currentUser } from "../../lib/supabase-server";
import { publicMissions } from "../../lib/missions";
import MissionsClient from "./missions-client";

export default async function MissionsPage() {
  // Strona tylko dla zalogowanych: bez zweryfikowanej sesji przekierowanie na logowanie.
  const user = await currentUser();
  if (!user) redirect(loginPath("/misje"));
  // Do przeglądarki trafia lista misji bez instrukcji dla modelu.
  return <MissionsClient account={user.account} missions={publicMissions()} />;
}
