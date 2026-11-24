import { randomUUID } from "node:crypto";
import ChatClient from "./chat-client";
import { currentUser } from "../lib/supabase-server";
import { loadLatestChat } from "../lib/chat-history";
import { CHAT_ERRORS } from "../lib/chat-errors";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { loginPath } from "../lib/redirect-target";
import { loadUserProfile } from "../lib/user-profile";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ chat?: string; new?: string }>;
}) {
  const params = await searchParams;
  const user = await currentUser();
  if (!user) redirect(loginPath(params.chat ? `/?chat=${encodeURIComponent(params.chat)}` : "/"));

  const emptyChat = { id: randomUUID(), messages: [] };
  let profileName: string | null = null;
  try { profileName = (await loadUserProfile()).name; } catch {}
  if (params.new === "1") return <ChatClient key={emptyChat.id} initialChat={emptyChat} profileName={profileName} email={user.email} />;
  if (params.chat && !z.uuid().safeParse(params.chat).success) notFound();
  let chat;
  try {
    chat = await loadLatestChat(params.chat);
  } catch {
    return <ChatClient initialChat={emptyChat} historyError={CHAT_ERRORS.history} profileName={profileName} email={user.email} />;
  }
  if (params.chat && !chat) notFound();
  return <ChatClient key={chat?.id ?? emptyChat.id} initialChat={chat ?? emptyChat} profileName={profileName} email={user.email} />;
}
