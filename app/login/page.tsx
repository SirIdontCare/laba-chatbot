import { redirect } from "next/navigation";
import { currentUser } from "../../lib/supabase-server";
import { supabaseAuthConfig } from "../../lib/supabase-config";
import { safeNextPath } from "../../lib/redirect-target";
import AuthForm from "./auth-form";

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const params = await searchParams;
  // Tylko ścieżki wewnątrz aplikacji; wszystko inne kończy się powrotem na czat.
  const next = safeNextPath(params.next);
  if (await currentUser()) redirect(next ?? "/");
  return <AuthForm configured={Boolean(supabaseAuthConfig())} confirmFailed={params.error === "confirm"} next={next} />;
}
