import "server-only";
import { z } from "zod";

export const toolFailureSchema = z.object({
  ok: z.literal(false), komunikat: z.string(), pobranoAt: z.iso.datetime(),
});
export const toolFailure = (komunikat: string) => ({
  ok: false as const, komunikat, pobranoAt: new Date().toISOString(),
});

export function apiOptions(abortSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10000);
  return {
    signal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout,
    cache: "no-store" as const,
    headers: { Accept: "application/json", "User-Agent": "LabaChatbot/0.1 (educational assistant)" },
  };
}
