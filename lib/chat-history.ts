import "server-only";
import { createHash } from "node:crypto";
import type { ChatMessage } from "./chat-message";
import { imageToolOutputSchema, inspectionOutputSchema } from "./image-tool-schema";
import { getSupabase } from "./supabase";

type StoredMessage = {
  turn_id: string;
  role: "user" | "assistant";
  content: string;
};

function sessionScope(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function messageContent(message: Pick<ChatMessage, "parts">) {
  let text = "";
  const imageMarkers: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      text += part.text.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=_-]+/gi, "[obraz]");
    } else if (part.type === "file" && part.mediaType.startsWith("image/")) {
      imageMarkers.push("[obraz]");
    } else if (part.type === "tool-generujObraz" && part.state === "output-available") {
      const output = imageToolOutputSchema.safeParse(part.output);
      if (output.success && output.data.ok) imageMarkers.push("[obraz]");
    } else if (part.type === "tool-obejrzyjObraz" && part.state === "output-available") {
      if (inspectionOutputSchema.safeParse(part.output).success) imageMarkers.push("[obraz]");
    }
  }

  return [text.trim(), ...imageMarkers].filter(Boolean).join("\n");
}

// Wywoływane przez stronę i endpoint po zweryfikowaniu podpisanego cookie.
export async function loadLatestChat(token: string, chatId?: string) {
  const db = getSupabase();
  let query = db.from("conversations")
    .select("id, chat_id")
    .eq("session_scope", sessionScope(token))
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (chatId) query = query.eq("chat_id", chatId);
  const { data: chat, error: chatError } = await query
    .abortSignal(AbortSignal.timeout(5_000))
    .maybeSingle()
    .overrideTypes<{ id: number; chat_id: string } | null, { merge: false }>();
  if (chatError) throw new Error("Supabase conversation read failed.");
  if (!chat) return null;

  const messages: ChatMessage[] = [];
  const pageSize = 500;
  const signal = AbortSignal.timeout(10_000);
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from("messages")
      .select("turn_id, role, content")
      .eq("conversation_id", chat.id)
      .order("id")
      .range(offset, offset + pageSize - 1)
      .abortSignal(signal)
      .overrideTypes<StoredMessage[], { merge: false }>();
    if (error) throw new Error("Supabase messages read failed.");
    for (const row of data) {
      messages.push({
        id: row.role === "user" ? row.turn_id : `${row.turn_id}-assistant`,
        role: row.role,
        parts: [{ type: "text", text: row.content }],
      });
    }
    if (data.length < pageSize) return { id: chat.chat_id, messages };
  }
}

export async function listChats(token: string) {
  const rows: { chat_id: string; title: string; created_at: string; messages: { count: number }[] }[] = [];
  const signal = AbortSignal.timeout(10_000);
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await getSupabase().from("conversations")
      .select("chat_id,title,created_at,messages(count)")
      .eq("session_scope", sessionScope(token))
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + 499).abortSignal(signal);
    if (error) throw new Error("Supabase history read failed.");
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

export async function saveChatTurn(
  token: string,
  chatId: string,
  question: ChatMessage,
  answer: Pick<ChatMessage, "parts">,
) {
  const assistantContent = messageContent(answer);
  if (!assistantContent) return;

  const db = getSupabase();
  const args = {
    p_session_scope: sessionScope(token),
    p_chat_id: chatId,
    p_turn_id: question.id,
    p_user_content: messageContent(question),
    p_assistant_content: assistantContent,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error, status } = await db.rpc("save_chat_turn", args)
      .abortSignal(AbortSignal.timeout(5_000));
    if (!error) return;
    if (status !== 0 && status < 500) break;
  }
  throw new Error("Supabase chat write failed.");
}
