import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";

export const SESSION_SECONDS = 8 * 60 * 60;
export const sessionCookieName = () =>
  process.env.NODE_ENV === "production" ? "__Host-workshop-session" : "workshop-session";

export function authConfig() {
  const password = process.env.CHAT_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!password?.trim() || !secret || Buffer.byteLength(secret) < 32) return null;
  // Zmiana hasła lub sekretu unieważnia poprzednie sesje.
  const key = createHmac("sha256", secret).update("workshop-session-v1\0").update(password).digest();
  return { password, key };
}

export function passwordMatches(candidate: string, expected: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(candidate), hash(expected));
}

export async function createSession(config: NonNullable<ReturnType<typeof authConfig>>) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("workshop")
    .setIssuer("laba-chatbot")
    .setAudience("workshop-chat")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_SECONDS)
    .sign(config.key);
}

export async function validSession(token?: string) {
  const config = authConfig();
  if (!config || !token) return false;
  try {
    const { payload } = await jwtVerify(token, config.key, {
      algorithms: ["HS256"], issuer: "laba-chatbot", audience: "workshop-chat",
      requiredClaims: ["sub", "iat", "exp"], maxTokenAge: SESSION_SECONDS,
    });
    return payload.sub === "workshop";
  } catch {
    return false;
  }
}

export function requestToken(request: Request) {
  // Kopiujemy tylko nagłówki, aby nie zużyć treści POST przed request.json().
  return new NextRequest(request.url, { headers: request.headers }).cookies.get(sessionCookieName())?.value;
}

export function sameOrigin(request: Request) {
  try {
    const target = new URL(request.url);
    // Next.js normalizuje adres URL 127.0.0.1 do localhost. Host zachowuje
    // rzeczywisty adres przeglądarki. Nie ufamy X-Forwarded-Host od klienta.
    const host = request.headers.get("host");
    const expected = host ? new URL(`${target.protocol}//${host}`).origin : target.origin;
    return request.headers.get("origin") === expected;
  } catch {
    return false;
  }
}

export function setSessionCookie(response: NextResponse, value: string, maxAge = SESSION_SECONDS) {
  response.cookies.set(sessionCookieName(), value, {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge, expires: new Date(Date.now() + maxAge * 1000),
  });
}
