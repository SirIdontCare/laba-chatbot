const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");

// Uruchamiamy prawdziwe handlery TS bez Next.js i bez ładowania plików .env.
require.extensions[".ts"] = (module, filename) => {
  const source = readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};

// Fikcyjny projekt Supabase. Sieć zastępuje atrapa serwera Supabase Auth.
const SUPABASE_URL = "https://authtest.supabase.co";
Object.assign(process.env, {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline_test",
  SESSION_SECRET: "offline-test-secret-32-characters-long",
  OPENROUTER_API_KEY: "", OPENROUTER_MODEL: "", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "",
});

const { POST: agent } = require("../app/api/agent/route.ts");
const { POST: dashboard } = require("../app/api/dashboard/route.ts");
const { DELETE: deleteChat } = require("../app/api/history/route.ts");
const { PATCH: profile } = require("../app/api/profile/route.ts");
const { POST: upload, DELETE: deleteDocument } = require("../app/api/upload/route.ts");
const { requestUser } = require("../lib/supabase-server.ts");
const { sameOrigin } = require("../lib/request-origin.ts");
const { updateSession } = require("../lib/supabase-proxy.ts");
const { AUTH_MESSAGES, authErrorMessage, MIN_PASSWORD_LENGTH } = require("../lib/auth-messages.ts");
const { safeNextPath, loginPath } = require("../lib/redirect-target.ts");
const { NextRequest } = require("next/server");

const origin = "http://localhost:3000";
const COOKIE_NAME = "sb-authtest-auth-token";
const alice = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alicja@example.com", sessionId: "s-alicja" };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
// Tokeny, które atrapa serwera Auth uznaje za ważne (jak po prawdziwym logowaniu).
const issued = new Map();
const revoked = new Set();

function accessToken(user, claims = {}) {
  return [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated",
      session_id: user.sessionId, iat: now(), exp: now() + 3600, iss: `${SUPABASE_URL}/auth/v1`, ...claims }),
    Buffer.from(`podpis-${Math.random()}`).toString("base64url"),
  ].join(".");
}

function sessionCookie(token, user, expiresAt = now() + 3600) {
  const session = {
    access_token: token, token_type: "bearer", expires_in: 3600, expires_at: expiresAt, refresh_token: "refresh-test",
    user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: {}, user_metadata: {} },
  };
  return `${COOKIE_NAME}=base64-${b64(session)}`;
}

function signIn(user) {
  const token = accessToken(user);
  issued.set(token, user);
  return { token, cookie: sessionCookie(token, user) };
}

// Atrapa Supabase Auth: /user potwierdza tylko wydane i nieunieważnione tokeny.
function authServer(t) {
  const calls = [];
  t.mock.method(global, "fetch", async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${SUPABASE_URL}/auth/v1/user`) {
      const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "");
      const user = issued.get(token);
      if (!user || revoked.has(token)) {
        return Response.json({ code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, { status: 403 });
      }
      return Response.json({ id: user.id, aud: "authenticated", role: "authenticated", email: user.email,
        app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      return Response.json({ code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }, { status: 400 });
    }
    throw new Error(`Sieć zablokowana w testach: ${url}`);
  });
  return calls;
}

const chatBody = { mode: "chat", messages: [{ id: "test", role: "user", parts: [{ type: "text", text: "Test" }] }] };
const request = (method, path, body, cookie = "", source = origin) => new Request(origin + path, {
  method, headers: { origin: source, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const endpoints = [
  ["POST /api/agent", (cookie, source) => agent(request("POST", "/api/agent", chatBody, cookie, source))],
  ["POST /api/dashboard", (cookie, source) => dashboard(request("POST", "/api/dashboard", { city: "Kraków", date: "2026-12-01" }, cookie, source))],
  ["DELETE /api/history", (cookie, source) => deleteChat(request("DELETE", "/api/history?chat=3f2504e0-4f89-41d3-9a0c-0305e82c3301", undefined, cookie, source))],
  ["PATCH /api/profile", (cookie, source) => profile(request("PATCH", "/api/profile", { action: "clear" }, cookie, source))],
  ["POST /api/upload", (cookie, source) => upload(request("POST", "/api/upload", { title: "Cennik", content: "Treść" }, cookie, source))],
  ["DELETE /api/upload", (cookie, source) => deleteDocument(request("DELETE", "/api/upload?document=1", undefined, cookie, source))],
];

async function unauthorizedMessage(response) {
  const text = await response.text();
  return text.startsWith("{") ? JSON.parse(text).error : text;
}

test("bez ciasteczek każdy endpoint zwraca 401, zanim dotknie sieci, bazy albo modelu", async (t) => {
  const calls = authServer(t);
  for (const [name, call] of endpoints) {
    const response = await call("");
    assert.equal(response.status, 401, name);
    assert.equal(await unauthorizedMessage(response), AUTH_MESSAGES.unauthorized, name);
  }
  assert.deepEqual(calls, []);
});

test("sfałszowany, nieznany lub uszkodzony token: 401 po weryfikacji, nie po samym ciasteczku", async (t) => {
  const calls = authServer(t);
  const forged = sessionCookie(accessToken(alice), alice); // poprawny wygląd, ale nie wydany przez Auth
  const { token } = signIn(alice);
  const [header, , signature] = token.split(".");
  const swapped = [header, b64({ sub: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "ktos@example.com",
    role: "authenticated", exp: now() + 3600 }), signature].join(".");
  for (const cookie of [forged, sessionCookie(swapped, alice), `${COOKIE_NAME}=base64-zepsute`, `${COOKIE_NAME}=nie-json`]) {
    for (const [name, call] of endpoints) assert.equal((await call(cookie)).status, 401, name);
  }
  // Sfałszowane tokeny zostały sprawdzone w Supabase Auth; nic więcej nie poszło do sieci.
  assert.ok(calls.length > 0);
  assert.ok(calls.every((url) => url === `${SUPABASE_URL}/auth/v1/user`));
});

test("wygasła sesja bez możliwości odświeżenia: 401", async (t) => {
  authServer(t);
  const token = accessToken(alice, { exp: now() - 60 });
  issued.set(token, alice);
  const cookie = sessionCookie(token, alice, now() - 60);
  for (const [name, call] of endpoints) assert.equal((await call(cookie)).status, 401, name);
});

test("poprawna sesja: tożsamość pochodzi ze zweryfikowanego tokenu i można ją sprawdzić ponownie", async (t) => {
  authServer(t);
  const { token, cookie } = signIn(alice);
  const user = await requestUser(request("POST", "/api/agent", chatBody, cookie));
  assert.equal(user.id, alice.id);
  assert.equal(user.email, alice.email);
  assert.equal(user.sessionId, alice.sessionId);
  assert.equal(await user.stillSignedIn(), true);
  revoked.add(token); // np. wylogowanie w innej karcie
  assert.equal(await user.stillSignedIn(), false);
  assert.equal(await requestUser(request("POST", "/api/agent", chatBody, cookie)), null);
});

test("identyfikator z adresu, nagłówka albo treści nie loguje", async (t) => {
  const calls = authServer(t);
  const spoofed = new Request(`${origin}/api/agent?user=${alice.id}&user_id=${alice.id}`, {
    method: "POST", headers: { origin, "x-user-id": alice.id, authorization: `Bearer ${alice.id}` },
    body: JSON.stringify({ ...chatBody, userId: alice.id }),
  });
  assert.equal(await requestUser(spoofed), null);
  assert.equal((await agent(spoofed)).status, 401);
  assert.deepEqual(calls, []);
});

test("zalogowany przechodzi bramkę, ale żądanie z obcej strony dostaje 403", async (t) => {
  authServer(t);
  const { cookie } = signIn(alice);
  for (const [name, call] of endpoints) {
    assert.equal((await call(cookie, "https://other.test")).status, 403, name);
  }
});

test("brak konfiguracji Supabase blokuje dostęp (401)", async (t) => {
  const calls = authServer(t);
  const { cookie } = signIn(alice);
  const saved = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "";
  try {
    for (const [name, call] of endpoints) assert.equal((await call(cookie)).status, 401, name);
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = saved;
  }
  assert.deepEqual(calls, []);
});

test("proxy: niezalogowany trafia na /login z adresem powrotu, API i logowanie przechodzą dalej", async (t) => {
  authServer(t);
  const { cookie } = signIn(alice);
  const visit = (path, withCookie = "") => updateSession(new NextRequest(origin + path, { headers: withCookie ? { cookie: withCookie } : {} }));
  const chatPath = "/?chat=3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  for (const [path, next] of [["/", null], ["/history", "/history"], ["/profile", "/profile"], ["/upload", "/upload"],
    ["/dashboard", "/dashboard"], [chatPath, chatPath]]) {
    const response = await visit(path);
    assert.equal(response.status, 307, path);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.pathname, "/login", path);
    assert.equal(location.searchParams.get("next"), next, path);
  }
  for (const path of ["/login", "/auth/confirm", "/api/agent"]) {
    assert.equal((await visit(path)).headers.get("x-middleware-next"), "1", path);
  }
  assert.equal((await visit("/history", cookie)).headers.get("x-middleware-next"), "1");
  // Zalogowany na /login wraca pod zapamiętany adres, ale nigdy na obcą stronę.
  for (const [path, expected] of [["/login", "/"], ["/login?next=%2Fupload", "/upload"], [`/login?next=${encodeURIComponent(chatPath)}`, chatPath],
    ["/login?next=%2F%2Fevil.example", "/"], ["/login?next=https%3A%2F%2Fevil.example", "/"], ["/login?next=%2F%5Cevil.example", "/"]]) {
    const response = await visit(path, cookie);
    assert.equal(response.status, 307, path);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, origin, path);
    assert.equal(location.pathname + location.search, expected, path);
  }
});

test("adres powrotu: tylko ścieżki wewnątrz aplikacji", () => {
  for (const [value, expected] of [["/upload", "/upload"], ["/?chat=abc", "/?chat=abc"], ["/history#top", "/history#top"],
    ["/profile?x=1&y=2", "/profile?x=1&y=2"], ["/%2F%2Fevil.example", "/%2F%2Fevil.example"]]) {
    assert.equal(safeNextPath(value), expected, value);
  }
  for (const value of ["//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example/upload", "http:/evil.example",
    "javascript:alert(1)", "upload", "", " /upload", "/login", "/login?next=/upload", "/auth/confirm", "/api/agent", "/_next/static/x.js",
    "/" + "a".repeat(2100), null, undefined, ["/upload"], 42]) {
    assert.equal(safeNextPath(value), null, String(value));
  }
  assert.equal(loginPath("/upload"), "/login?next=%2Fupload");
  assert.equal(loginPath("/?chat=abc"), "/login?next=%2F%3Fchat%3Dabc");
  assert.equal(loginPath("/"), "/login");
  assert.equal(loginPath("//evil.example"), "/login");
});

test("sprawdzanie źródła: NextRequest normalizuje 127.0.0.1, liczy się prawdziwy Host", () => {
  const local = new NextRequest("http://127.0.0.1:3000/api/agent", {
    method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
  });
  assert.equal(new URL(local.url).hostname, "localhost");
  assert.equal(sameOrigin(local), true);
  assert.equal(sameOrigin(new NextRequest(`${origin}/api/agent`, { method: "POST", headers: { host: "localhost:3000", origin } })), true);
  for (const source of ["https://other.test", "http://127.0.0.1:3001", "http://localhost:3000", "null", ""]) {
    const foreign = new NextRequest("http://127.0.0.1:3000/api/agent", {
      method: "POST", headers: { host: "127.0.0.1:3000", origin: source, "x-forwarded-host": "other.test" },
    });
    assert.equal(sameOrigin(foreign), false, source);
  }
});

test("błędy logowania i rejestracji po polsku", () => {
  assert.equal(authErrorMessage({ code: "invalid_credentials", status: 400 }), "Nieprawidłowy e-mail lub hasło.");
  assert.equal(authErrorMessage({ message: "Invalid login credentials", status: 400 }), AUTH_MESSAGES.invalidCredentials);
  for (const code of ["user_already_exists", "email_exists"]) {
    assert.equal(authErrorMessage({ code, status: 422 }), "Konto z tym adresem e-mail już istnieje. Zaloguj się.");
  }
  assert.equal(authErrorMessage({ code: "weak_password", status: 422 }), AUTH_MESSAGES.weakPassword);
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.match(AUTH_MESSAGES.passwordTooShort, /za krótkie.*8 znaków/);
  assert.equal(authErrorMessage({ code: "email_not_confirmed" }), AUTH_MESSAGES.emailNotConfirmed);
  assert.equal(authErrorMessage({ code: "over_request_rate_limit", status: 429 }), AUTH_MESSAGES.rateLimited);
  assert.equal(authErrorMessage({ name: "AuthRetryableFetchError", status: 0 }), AUTH_MESSAGES.network);
  assert.equal(authErrorMessage({ code: "cos_nowego", message: "Something else" }), AUTH_MESSAGES.unknown);
});
