import { z } from "zod";
import { requestUser } from "../../../lib/supabase-server";
import { sameOrigin } from "../../../lib/request-origin";
import { AUTH_MESSAGES } from "../../../lib/auth-messages";
import {
  deleteDocument, findDocumentsByTitle, KB_MESSAGES, KnowledgeBaseError, saveDocument, uploadSchema,
  type ImportStage,
} from "../../../lib/knowledge-base";
import type { UploadStreamEvent } from "../../../lib/upload-stream";

async function authorize(request: Request) {
  // Weryfikacja użytkownika przed odczytem danych i przed bazą.
  if (!await requestUser(request)) return new Response(AUTH_MESSAGES.unauthorized, { status: 401 });
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  return null;
}

export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  let input;
  try { input = uploadSchema.safeParse(await request.json()); }
  catch { return new Response("Nieprawidłowe dane formularza.", { status: 400 }); }
  if (!input.success) {
    return new Response("Uzupełnij tytuł (do 200 znaków) i treść (do 20 000 znaków).", { status: 400 });
  }
  let existing;
  try { existing = await findDocumentsByTitle(input.data.title); }
  catch { return new Response("Nie udało się sprawdzić, czy dokument już istnieje. Nic nie zostało zapisane. Spróbuj ponownie za chwilę.", { status: 503 }); }
  // Dokument o tym tytule już jest: zastępujemy go tylko po potwierdzeniu użytkownika.
  if (existing.length && !input.data.replace) return Response.json({ existing }, { status: 409 });

  const encoder = new TextEncoder();
  const data = input.data;
  let stage: ImportStage = "split";
  const stream = new ReadableStream({
    async start(controller) {
      // Strumień NDJSON: zdarzenia "stage" po kolei, na końcu "done" albo "error" z etapem i komunikatem.
      const send = (event: UploadStreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const document = await saveDocument(data, {
          replaceIds: existing.map(doc => doc.id),
          onStage: next => { stage = next; send({ type: "stage", stage: next }); },
        });
        send({ type: "done", document });
      } catch (error) {
        send(error instanceof KnowledgeBaseError
          ? { type: "error", stage: error.stage, message: error.message }
          : { type: "error", stage, message: KB_MESSAGES.document });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" },
  });
}

export async function DELETE(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const input = z.coerce.number().int().positive().safeParse(new URL(request.url).searchParams.get("document"));
  if (!input.success) return new Response("Nieprawidłowy dokument.", { status: 400 });
  try {
    if (!await deleteDocument(input.data)) return new Response("Ten dokument został już usunięty.", { status: 404 });
    return new Response(null, { status: 204 });
  } catch {
    return new Response("Nie udało się usunąć dokumentu. Spróbuj ponownie.", { status: 503 });
  }
}
