import "server-only";
import { aktualnyCzas, czas } from "./chat-tools";
import { pogoda } from "./weather-tool";
import { waluty } from "./currency-tool";
import { swieta } from "./holidays-tool";
import { wikipedia } from "./wikipedia-tool";
import { kalkulator, createNotesTool, createDiagnosticsTool } from "./local-tools";
import { generujObraz } from "./image-generation";
import { obejrzyjObraz } from "./image-inspection";
import { AGENT_STEP_LIMIT } from "./tool-catalog";
import { createProfileTool } from "./user-profile";
import type { SignedInUser } from "./supabase-server";
import { searchKnowledge } from "./knowledge-search";

// `owner` to zweryfikowana osoba z serwera (bez niej narzędzie profilu odmawia zapisu).
export function createAgentTools(sessionScope: string, owner: Pick<SignedInUser, "db" | "id" | "stillSignedIn"> | null = null,
  currentMessage = () => "", previousAssistant = () => "") {
  const tools = { searchKnowledge, aktualnyCzas, czas, pogoda, waluty, swieta, wikipedia, kalkulator,
    notatki: createNotesTool(sessionScope), generujObraz, obejrzyjObraz,
    zapiszProfil: createProfileTool(owner, currentMessage, previousAssistant) };
  return { ...tools, diagnostyka: createDiagnosticsTool([...Object.keys(tools), "diagnostyka", "web_search"], AGENT_STEP_LIMIT) };
}
