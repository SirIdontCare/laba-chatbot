import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import ChatClient from "./chat-client";
import LoginForm from "./login-form";
import { authConfig, sessionCookieName, validSession } from "../lib/session";
import { loadLatestChat } from "../lib/chat-history";
import { CHAT_ERRORS } from "../lib/chat-errors";

export default async function Home() {
  const configured = Boolean(authConfig());
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!configured || !token || !(await validSession(token))) {
    return <LoginForm configured={configured} />;
  }

  const emptyChat = { id: randomUUID(), messages: [] };
  try {
    const chat = await loadLatestChat(token);
    return <ChatClient initialChat={chat ?? emptyChat} />;
  } catch {
    return <ChatClient initialChat={emptyChat} historyError={CHAT_ERRORS.history} />;
  }
}
