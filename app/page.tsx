import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import ChatClient from "./chat-client";
import LoginForm from "./login-form";
import { authConfig, sessionCookieName, validSession } from "../lib/session";
import { loadLatestChat } from "../lib/chat-history";
import { CHAT_ERRORS } from "../lib/chat-errors";
import { z } from "zod";
import { notFound } from "next/navigation";
import { loadUserProfile } from "../lib/user-profile";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ chat?: string; new?: string }>;
}) {
  const configured = Boolean(authConfig());
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!configured || !token || !(await validSession(token))) {
    return <LoginForm configured={configured} />;
  }

  const emptyChat = { id: randomUUID(), messages: [] };
  let profileName: string | null = null;
  try { profileName = (await loadUserProfile()).name; } catch {}
  const params = await searchParams;
  if (params.new === "1") return <ChatClient key={emptyChat.id} initialChat={emptyChat} profileName={profileName} />;
  if (params.chat && !z.uuid().safeParse(params.chat).success) notFound();
  let chat;
  try {
    chat = await loadLatestChat(token, params.chat);
  } catch {
    return <ChatClient initialChat={emptyChat} historyError={CHAT_ERRORS.history} profileName={profileName} />;
  }
  if (params.chat && !chat) notFound();
  return <ChatClient key={chat?.id ?? emptyChat.id} initialChat={chat ?? emptyChat} profileName={profileName} />;
}
