import { NextResponse } from "next/server";
import { AUTH_MESSAGES } from "../../../../lib/auth-messages";
import { sameOrigin, setSessionCookie } from "../../../../lib/session";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(AUTH_MESSAGES.origin, { status: 403 });
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  setSessionCookie(response, "", 0);
  return response;
}
