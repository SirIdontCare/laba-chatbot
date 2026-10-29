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

process.env.NODE_ENV = "development";
process.env.VERCEL = "";
process.env.VERCEL_PROJECT_PRODUCTION_URL = "";
process.env.CHAT_PASSWORD = "test-workshop-password";
process.env.SESSION_SECRET = "offline-test-secret-32-characters-long";
process.env.OPENROUTER_API_KEY = "";
process.env.OPENROUTER_MODEL = "";

const { POST: login } = require("../app/api/auth/login/route.ts");
const { POST: logout } = require("../app/api/auth/logout/route.ts");
const { POST: chat } = require("../app/api/chat/route.ts");
const { authConfig, validSession, sameOrigin, SESSION_SECONDS } = require("../lib/session.ts");
const { NextRequest } = require("next/server");
const { SignJWT } = require("jose");
const origin = "http://localhost:3000";
const makeRequest = (path, body, cookie = "", source = origin) => new Request(origin + path, {
  method: "POST", headers: { origin: source, "content-type": "application/json", cookie },
  body: JSON.stringify(body),
});
const chatBody = { messages: [{ id: "test", role: "user", parts: [{ type: "text", text: "Test" }] }] };
let cookie;

test("ochrona czatu bez platnych wywolan", async (t) => {
  t.mock.method(global, "fetch", async () => { throw new Error("Siec zablokowana w testach"); });

  await t.test("brak i niepelna konfiguracja blokuja dostep", async () => {
    process.env.CHAT_PASSWORD = "";
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test" }))).status, 503);
    assert.equal((await chat(makeRequest("/api/chat", chatBody))).status, 401);
    process.env.CHAT_PASSWORD = "test-workshop-password";
    process.env.SESSION_SECRET = "short";
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }))).status, 503);
    process.env.SESSION_SECRET = "offline-test-secret-32-characters-long";
  });

  await t.test("bledne haslo nie ustawia cookie", async () => {
    const response = await login(makeRequest("/api/auth/login", { password: "wrong" }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  });

  await t.test("poprawne haslo tworzy podpisana sesje na 8 godzin", async () => {
    const response = await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }));
    assert.equal(response.status, 204);
    const header = response.headers.get("set-cookie");
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=strict/i);
    assert.match(header, /Max-Age=28800/i);
    assert.doesNotMatch(header, /; Secure/i);
    cookie = header.split(";")[0];
    const token = cookie.slice(cookie.indexOf("=") + 1);
    assert.equal(await validSession(token), true);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    assert.equal(payload.exp - payload.iat, SESSION_SECONDS);
    assert.deepEqual(Object.keys(payload).sort(), ["aud", "exp", "iat", "iss", "sub"]);
    assert.equal(JSON.stringify(payload).includes("test-workshop-password"), false);
  });

  await t.test("brak lub podrobione cookie daje 401 przed OpenRouter", async () => {
    assert.equal((await chat(makeRequest("/api/chat", chatBody))).status, 401);
    assert.equal((await chat(makeRequest("/api/chat", chatBody, "workshop-session=forged"))).status, 401);
    // Prawdziwa sesja przechodzi autoryzację, potem trafia na brak konfiguracji AI.
    assert.equal((await chat(makeRequest("/api/chat", chatBody, cookie))).status, 503);
  });

  await t.test("wygasla sesja i zmiana hasla sa odrzucane", async () => {
    const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" })
      .setSubject("workshop").setIssuer("laba-chatbot").setAudience("workshop-chat")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100).setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(authConfig().key);
    assert.equal((await chat(makeRequest("/api/chat", chatBody, "workshop-session=" + expired))).status, 401);
    process.env.CHAT_PASSWORD = "changed-password";
    assert.equal((await chat(makeRequest("/api/chat", chatBody, cookie))).status, 401);
    process.env.CHAT_PASSWORD = "test-workshop-password";
  });

  await t.test("wyjscie usuwa cookie; nastepne zadanie bez sesji daje 401", async () => {
    const response = await logout(makeRequest("/api/auth/logout", {}, cookie));
    assert.equal(response.status, 204);
    const deleted = response.headers.get("set-cookie");
    assert.match(deleted, /^workshop-session=;/);
    assert.match(deleted, /Max-Age=0/i);
    assert.equal((await chat(makeRequest("/api/chat", chatBody, deleted.split(";")[0]))).status, 401);
  });

  await t.test("zadania z obcej strony sa odrzucane", async () => {
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }, "", "https://other.test"))).status, 403);
    assert.equal((await logout(makeRequest("/api/auth/logout", {}, cookie, "https://other.test"))).status, 403);
    assert.equal((await chat(makeRequest("/api/chat", chatBody, cookie, "https://other.test"))).status, 403);
  });

  await t.test("NextRequest normalizuje 127.0.0.1; kontrola uzywa rzeczywistego Host", async () => {
    const localRequest = new NextRequest("http://127.0.0.1:3000/api/auth/logout", {
      method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    });
    assert.equal(new URL(localRequest.url).hostname, "localhost");
    assert.equal(sameOrigin(localRequest), true);
    assert.equal((await logout(localRequest)).status, 204);

    const localName = new NextRequest(origin + "/api/auth/logout", {
      method: "POST", headers: { host: "localhost:3000", origin },
    });
    assert.equal(sameOrigin(localName), true);

    for (const source of ["https://other.test", "http://127.0.0.1:3001", "http://localhost:3000", "null", ""]) {
      const foreign = new NextRequest("http://127.0.0.1:3000/api/auth/logout", {
        method: "POST", headers: {
          host: "127.0.0.1:3000", origin: source,
          "x-forwarded-host": "other.test",
        },
      });
      assert.equal(sameOrigin(foreign), false);
      assert.equal((await logout(foreign)).status, 403);
    }
  });

  await t.test("lokalnie szosta proba w oknie minuty jest blokowana", async () => {
    const clock = t.mock.method(Date, "now", () => new Date().getTime() + 60_001);
    for (let i = 0; i < 5; i++) {
      assert.equal((await login(makeRequest("/api/auth/login", { password: "wrong" }))).status, 401);
    }
    const response = await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    clock.mock.restore();
  });

  await t.test("produkcja bez uslugi limitujacej blokuje logowanie", async () => {
    process.env.NODE_ENV = "production";
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }))).status, 503);
  });

  await t.test("produkcja sprawdza wspolny limit i ustawia Secure", async () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_URL = "protected-deployment.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "offline-test.vercel.app";
    let status = 404;
    const firewallFetch = t.mock.method(global, "fetch", async (url, init) => {
      assert.match(url, /^https:\/\/offline-test\.vercel\.app\/\.well-known\/vercel\/rate-limit-api\/workshop-login$/);
      assert.equal(init.headers.get("x-rr-cookie"), null);
      return new Response(null, { status });
    });
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }))).status, 503);
    status = 429;
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }))).status, 429);
    status = 204;
    const response = await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }));
    assert.equal(response.status, 204);
    assert.match(response.headers.get("set-cookie"), /^__Host-workshop-session=/);
    assert.match(response.headers.get("set-cookie"), /; Secure/i);
    assert.equal(firewallFetch.mock.callCount(), 3);
    firewallFetch.mock.restore();
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }))).status, 503);
  });

  await t.test("brak publicznego adresu blokuje logowanie bez proby chronionego wdrozenia", async () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "";
    const blockedFetch = t.mock.method(global, "fetch", async () => {
      throw new Error("Nie wolno laczyc sie z technicznym adresem wdrozenia");
    });
    assert.equal((await login(makeRequest("/api/auth/login", { password: "test-workshop-password" }))).status, 503);
    assert.equal(blockedFetch.mock.callCount(), 0);
    blockedFetch.mock.restore();
  });
});
