import { cookies } from "next/headers";
import ChatClient from "./chat-client";
import LoginForm from "./login-form";
import { authConfig, sessionCookieName, validSession } from "../lib/session";

export default async function Home() {
  const configured = Boolean(authConfig());
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!configured || !(await validSession(token))) {
    return <LoginForm configured={configured} />;
  }
  return <ChatClient />;
}
