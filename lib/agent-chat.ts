import "server-only";
import { createHash } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type UIMessageChunk,
} from "ai";
import { chatMessageMetadataSchema, type ChatMessage } from "./chat-message";
import { AGENT_CHAT_INSTRUCTIONS } from "./studio-nova";
import { CHAT_ERRORS } from "./chat-errors";
import { needsCurrentDate, warsawTime } from "./chat-tools";
import { validPhotoPart } from "./image-validation";
import { IMAGE_MESSAGES } from "./image-input";
import { imageToolInputSchema } from "./image-tool-schema";
import { createAgentTools } from "./agent-tools";
import { AGENT_STEP_LIMIT } from "./tool-catalog";
import type { SignedInUser } from "./supabase-server";
import { claimConversation, discardEmptyConversation, saveChatTurn } from "./chat-history";
import { loadUserProfile, PROFILE_INSTRUCTIONS, profileFollowUp } from "./user-profile";

const turnIdSchema = z.uuid();

export async function agentChat(
  request: Request,
  { messages: inputMessages, intent, chatId }: { messages: unknown; intent?: "image"; chatId?: string },
  user: SignedInUser,
) {
  const startedAt = Date.now();
  let toolCalls = 0;
  let stoppedReason = "";
  const taskTimeout = AbortSignal.timeout(60_000);
  const taskSignal = AbortSignal.any([request.signal, taskTimeout]);
  let messages: ChatMessage[];
  // Przestrzeń notatek wynika ze zweryfikowanej sesji logowania; model jej nie wybiera.
  const scope = createHash("sha256").update(`${user.id}:${user.sessionId ?? ""}`).digest("hex");
  const localTools = createAgentTools(scope, user, () => messages?.at(-1)?.parts
    .filter(part => part.type === "text").map(part => part.text).join(" ") ?? "",
    () => messages?.at(-2)?.role === "assistant" ? messages.at(-2)!.parts
      .filter(part => part.type === "text").map(part => part.text).join(" ") : "");
  const isLocalToolPart = (type: string) => type.startsWith("tool-") && Object.hasOwn(localTools, type.slice(5));

  try {
    messages = await validateUIMessages<ChatMessage>({
      messages: inputMessages,
      metadataSchema: chatMessageMetadataSchema.optional(),
      tools: localTools,
    });

    const lastMessage = messages.at(-1);
    for (const message of messages) {
      const photos = message.parts.filter((part) => part.type === "file");
      if (photos.length > 1 || photos.some((part) => message.role !== "user" || !validPhotoPart(part))) {
        return new Response(IMAGE_MESSAGES.invalidPhoto, { status: 400 });
      }
    }
    if (
      !messages.every(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          message.parts.every(
            (part) => part.type === "text" || part.type === "step-start" ||
              (message.role === "user" && part.type === "file") ||
              (message.role === "assistant" &&
                (part.type === "source-url" || isLocalToolPart(part.type))),
          ),
      ) ||
      lastMessage?.role !== "user" ||
      (chatId && !turnIdSchema.safeParse(lastMessage.id).success) ||
      !lastMessage.parts.some(
        (part) => (part.type === "text" && part.text.trim().length > 0) || part.type === "file",
      )
    ) {
      return new Response(CHAT_ERRORS.invalid, { status: 400 });
    }
    if (intent === "image") {
      const prompt = lastMessage.parts.filter((part) => part.type === "text").map((part) => part.text).join(" ");
      if (!imageToolInputSchema.safeParse({ prompt }).success || lastMessage.parts.some((part) => part.type === "file")) {
        return new Response(IMAGE_MESSAGES.invalidPrompt, { status: 400 });
      }
    }
  } catch {
    return new Response(CHAT_ERRORS.invalid, { status: 400 });
  }

  // Te zmienne są odczytywane wyłącznie w serwerowym endpointcie.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();

  if (!apiKey || !model) {
    return new Response(CHAT_ERRORS.configuration, { status: 503 });
  }

  // Rozmowa musi należeć do zalogowanej osoby. Cudzy identyfikator kończy się 404
  // zanim cokolwiek zostanie odczytane, zapisane albo wysłane do modelu.
  let claimedNew = false;
  if (chatId) {
    let claim;
    try { claim = await claimConversation(user, chatId, messages.at(-1)!); }
    catch { return new Response(CHAT_ERRORS.save, { status: 503 }); }
    if (claim === "taken") return new Response(CHAT_ERRORS.notFound, { status: 404 });
    claimedNew = claim === "created";
  }
  const discardClaim = async () => {
    if (claimedNew && chatId) try { await discardEmptyConversation(user, chatId); } catch {}
  };
  const hasPhoto = messages.some((message) => message.parts.some((part) => part.type === "file"));
  const unavailableMessage = hasPhoto ? CHAT_ERRORS.visionUnavailable : CHAT_ERRORS.unavailable;

  try {
    // Profil zalogowanej osoby (RLS), nigdy wspólny ani wskazany przez model.
    const profile = await loadUserProfile(user);
    const openrouter = createOpenRouter({ apiKey });
    const question = messages.at(-1)!;
    const lastQuestion = question.parts
      .filter((part) => part.type === "text").map((part) => part.text).join(" ");
    const checkDateFirst = needsCurrentDate(lastQuestion);
    const tools = {
      web_search: openrouter.tools.webSearch({
        maxResults: 3,
        engine: "native",
        searchPrompt: `Bieżąca data w Europe/Warsaw: ${warsawTime().data}. ` +
          "Dla pytań o najnowsze informacje szukaj najpierw publikacji z ostatnich 7 dni, " +
          "potem 30 dni. Preferuj oficjalne ogłoszenia i sprawdzaj daty publikacji oraz wydarzeń. " +
          "Nie przedstawiaj starszych wyników jako najnowszych bez potwierdzenia.",
      }),
      ...localTools,
    };
    for (const [name, entry] of Object.entries(tools)) {
      if (!entry.execute) continue;
      const execute = entry.execute as (input: unknown, options: { abortSignal?: AbortSignal; toolCallId: string; messages: import("ai").ModelMessage[] }) => unknown;
      const wrapped = { ...entry };
      Object.assign(wrapped, { execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        if (stoppedReason || toolCalls >= 16 || taskSignal.aborted) {
          stoppedReason ||= toolCalls >= 16 ? "Osiągnięto limit 16 wywołań narzędzi." : "Upłynął limit czasu zadania.";
          return { ok: false, komunikat: stoppedReason, pobranoAt: new Date().toISOString() };
        }
        toolCalls++;
        const timeout = AbortSignal.timeout(10_000);
        const signal = AbortSignal.any([taskSignal, timeout]);
        let onAbort: () => void = () => {};
        try {
          const output = await Promise.race([
            execute(input, { ...options, abortSignal: signal }),
            new Promise((_, reject) => {
              onAbort = () => reject(new Error("timeout"));
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
            }),
          ]);
          if (output && typeof output === "object" && "ok" in output && output.ok === false) {
            stoppedReason = `Nie udało się sprawdzić wyniku narzędzia ${name}. Kończę z wynikiem częściowym.`;
          }
          return output;
        } catch {
          stoppedReason = `Nie udało się sprawdzić wyniku narzędzia ${name}: źródło nie odpowiada. Kończę z wynikiem częściowym.`;
          return { ok: false, komunikat: stoppedReason, pobranoAt: new Date().toISOString() };
        } finally { signal.removeEventListener("abort", onAbort); }
      } });
      Object.assign(tools, { [name]: wrapped });
    }
    // Pomijamy puste odpowiedzi pozostałe po przerwanym lub błędnym strumieniu.
    const history = messages.filter((message) =>
      message.parts.some((part) => (part.type === "text" && part.text.trim()) ||
        isLocalToolPart(part.type) || part.type === "file"),
    );
    let actualModelId: string | null = null;
    let modelSteps = 0;
    const executionSteps: { number: number; tool: string }[] = [];
    const partialResults: { tool: string; text: string }[] = [];
    let inspectedImage = messages.some((message) => message.parts.some((part) => part.type === "tool-obejrzyjObraz" && part.state === "output-available"));
    const result = streamText({
      model: openrouter(model, { parallelToolCalls: false }),
      instructions: AGENT_CHAT_INSTRUCTIONS + PROFILE_INSTRUCTIONS + profileFollowUp(profile.preferences) +
        "\nDane profilu użytkownika (JSON):\n" + JSON.stringify(profile) + (intent === "image"
        ? "\nUżytkownik użył przycisku generowania. Wywołaj generujObraz dokładnie raz, używając ostatniej wiadomości jako prompt bez zmiany opisu." : ""),
      messages: await convertToModelMessages(history, {
        tools: localTools,
        ignoreIncompleteToolCalls: true,
      }),
      tools,
      includeRawChunks: true,
      prepareStep: ({ stepNumber }) => {
        if (intent === "image" && stepNumber === 0) {
          return { activeTools: ["generujObraz"], toolChoice: { type: "tool", toolName: "generujObraz" } };
        }
        if (checkDateFirst && stepNumber === 0) {
          return {
            activeTools: ["aktualnyCzas"],
            toolChoice: { type: "tool", toolName: "aktualnyCzas" },
          };
        }
      },
      stopWhen: [isStepCount(AGENT_STEP_LIMIT), () => !!stoppedReason || toolCalls >= 16],
      abortSignal: taskSignal,
      maxRetries: 0,
      onError: () => {}, // Nie zapisujemy sekretów ani treści rozmowy w logach.
    });

    let saveFailed = false;
    const uiStream = toUIMessageStream({
      stream: result.stream,
      tools,
      originalMessages: messages,
      sendReasoning: false,
      sendSources: true,
      messageMetadata: ({ part }) => {
        if (part.type === "start-step") { actualModelId = null; modelSteps++; }
        if (part.type === "tool-call") {
          executionSteps.push({ number: modelSteps, tool: part.toolName });
          return { steps: [...executionSteps] };
        }
        // Wyszukiwanie natywne może raportować wyłącznie źródła, bez tool-call.
        if (part.type === "source" && part.sourceType === "url") {
          if (!executionSteps.some((step) => step.number === modelSteps && step.tool === "web_search")) {
            executionSteps.push({ number: modelSteps, tool: "web_search" });
          }
          if (partialResults.length < 24) partialResults.push({ tool: "web_search", text: `${part.title ?? "Źródło"}: ${part.url}` });
          return { steps: [...executionSteps] };
        }
        if (part.type === "tool-result" && partialResults.length < 24) {
          // Wyniki narzędzi, bez rozumowania modelu i bez danych plików obrazowych.
          const text = part.toolName === "generujObraz" || part.toolName === "obejrzyjObraz"
            ? "Wynik obsługi obrazu jest widoczny w rozmowie."
            : JSON.stringify(part.output)?.slice(0, 2000) ?? "Narzędzie nie zwróciło danych.";
          partialResults.push({ tool: part.toolName, text });
        }
        if (part.type === "tool-result" && part.toolName === "obejrzyjObraz") inspectedImage = true;
        if (part.type === "raw") {
          const raw = part.rawValue;
          if (raw && typeof raw === "object" && "model" in raw && typeof raw.model === "string" && raw.model.trim()) {
            actualModelId = raw.model;
          }
        }
        if (part.type === "finish" || part.type === "abort") return {
          stats: { steps: modelSteps, toolCalls, elapsedMs: Date.now() - startedAt },
          stoppedReason: stoppedReason || (taskTimeout.aborted ? "Upłynął limit 60 sekund. Kończę z wynikiem częściowym." : toolCalls >= 16 ? "Osiągnięto limit 16 wywołań narzędzi." : ""),
          retrievedAt: new Date().toISOString(), modelId: actualModelId, vision: hasPhoto || inspectedImage,
          steps: [...executionSteps], limitReached: modelSteps >= AGENT_STEP_LIMIT,
          partialResults,
        };
      },
      onError: () => unavailableMessage,
      onEnd: chatId ? async ({ isAborted, isCancelled, outcome, finishReason, responseMessage }) => {
        if (isAborted || isCancelled || outcome.status !== "completed" || finishReason === "error") return discardClaim();
        try {
          if (!await user.stillSignedIn()) throw new Error("Session expired.");
          await saveChatTurn(user, chatId, question, responseMessage, user.stillSignedIn);
        } catch {
          saveFailed = true;
          await discardClaim();
        }
      } : undefined,
    });

    // Potwierdzenie zakończenia dociera do klienta dopiero po powrocie z Supabase.
    let finishChunk: UIMessageChunk | undefined;
    const stream = chatId ? uiStream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "finish") finishChunk = chunk;
        else controller.enqueue(chunk);
      },
      flush(controller) {
        if (saveFailed) controller.enqueue({ type: "error", errorText: CHAT_ERRORS.save });
        else if (finishChunk) controller.enqueue(finishChunk);
      },
    })) : uiStream;
    return createUIMessageStreamResponse({ stream });
  } catch {
    await discardClaim();
    return new Response(unavailableMessage, { status: 502 });
  }
}
