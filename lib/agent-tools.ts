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

export function createAgentTools(sessionScope: string) {
  const tools = { aktualnyCzas, czas, pogoda, waluty, swieta, wikipedia, kalkulator,
    notatki: createNotesTool(sessionScope), generujObraz, obejrzyjObraz };
  return { ...tools, diagnostyka: createDiagnosticsTool([...Object.keys(tools), "diagnostyka", "web_search"], AGENT_STEP_LIMIT) };
}
