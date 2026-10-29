import { NextResponse } from "next/server";
import { AUTH_MESSAGES } from "../../../../lib/auth-messages";
import { authConfig, createSession, passwordMatches, sameOrigin, setSessionCookie } from "../../../../lib/session";
import { limitLogin } from "../../../../lib/login-limit";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  const config = authConfig();
  if (!config) return new Response(AUTH_MESSAGES.configuration, { status: 503 });
  const limited = await limitLogin();
  if (limited) return limited;

  let password: unknown;
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error();
    ({ password } = await request.json());
  } catch {
    return new Response(AUTH_MESSAGES.invalid, { status: 400 });
  }
  if (typeof password !== "string" || password.length > 1024 || !passwordMatches(password, config.password)) {
    return new Response(AUTH_MESSAGES.invalid, { status: 401 });
  }
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  setSessionCookie(response, await createSession(config));
  return response;
}
