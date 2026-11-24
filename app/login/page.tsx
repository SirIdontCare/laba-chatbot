import { redirect } from "next/navigation";
import { currentUser } from "../../lib/supabase-server";
import { supabaseAuthConfig } from "../../lib/supabase-config";
import AuthForm from "./auth-form";

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect("/");
  const params = await searchParams;
  return <AuthForm configured={Boolean(supabaseAuthConfig())} confirmFailed={params.error === "confirm"} />;
}
