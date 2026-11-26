import { redirect } from "next/navigation";
import { loginPath } from "../../lib/redirect-target";
import { currentUser } from "../../lib/supabase-server";
import TriageClient from "./triage-client";

export default async function EmailTriagePage() {
  // Strona tylko dla zalogowanych: bez zweryfikowanej sesji przekierowanie na logowanie.
  const user = await currentUser();
  if (!user) redirect(loginPath("/email-triage"));
  return <TriageClient account={user.account} />;
}
