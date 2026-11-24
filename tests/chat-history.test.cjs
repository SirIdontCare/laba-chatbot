const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
// Klucz secret celowo ustawiony: rozmowy nie mogą z niego korzystać.
Object.assign(process.env, { SUPABASE_URL: "https://secret-db.test", SUPABASE_SECRET_KEY: "offline-secret",
  OPENROUTER_API_KEY: "", OPENROUTER_MODEL: "" });
const { installFakeAuth, testUser, TEST_USER, TEST_AUTH_COOKIE, USER_DB_URL, USER_DB_TOKEN } = require("./fake-auth.cjs");
installFakeAuth();
const { saveChatTurn, loadLatestChat, listChats, deleteChat } = require("../lib/chat-history.ts");
const { DELETE: deleteRoute } = require("../app/api/history/route.ts");

const CHAT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const question = { id: "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e01", role: "user", parts: [{ type: "text", text: "Gdzie zjeść pierogi?" }] };
const answer = { parts: [{ type: "text", text: "Polecam Pierogarnię." }] };

// Atrapa PostgREST dla conversations i messages widzianych przez RLS. Baza sama wpisuje
// user_id (jak domyślne auth.uid()); kod nie może go wysyłać ani używać klucza secret.
function chatTables(t) {
  const db = { conversations: [], messages: [], requests: [], violations: [] };
  let nextId = 1;
  t.mock.method(global, "fetch", async (raw, options = {}) => {
    const url = new URL(String(raw instanceof Request ? raw.url : raw));
    const headers = new Headers(options.headers);
    const method = options.method ?? "GET";
    if (url.origin !== USER_DB_URL) throw new Error(`Sieć zablokowana w testach: ${url.origin}`);
    db.requests.push(`${method} ${url.pathname}`);
    if (headers.get("authorization") !== `Bearer ${USER_DB_TOKEN}`) db.violations.push("brak tokenu użytkownika");
    const body = options.body ? JSON.parse(options.body) : null;
    for (const row of [body].flat().filter(Boolean)) if ("user_id" in row) db.violations.push("user_id w treści");
    if (method !== "POST" && url.searchParams.get("user_id") !== `eq.${TEST_USER.id}`) db.violations.push(`brak filtra user_id: ${method} ${url.pathname}`);
    const table = url.pathname.replace("/rest/v1/", "");
    const rows = db[table];
    const matches = (row) => [...url.searchParams].every(([key, value]) =>
      ["select", "order", "limit", "offset", "on_conflict"].includes(key) || String(row[key]) === value.replace(/^eq\./, ""));
    const reply = (data) => headers.get("accept")?.includes("vnd.pgrst.object") ? Response.json(data[0] ?? null) : Response.json(data);
    if (method === "GET") {
      return reply(rows.filter(matches).map((row) => table === "conversations"
        ? { ...row, messages: [{ count: db.messages.filter((m) => m.conversation_id === row.id).length }] } : row));
    }
    if (method === "POST" && table === "conversations") {
      const row = { id: nextId++, user_id: TEST_USER.id, created_at: new Date().toISOString(), ...body };
      rows.push(row);
      return reply([{ id: row.id }]);
    }
    if (method === "POST" && table === "messages") {
      for (const message of body) {
        const duplicate = rows.some((m) => m.conversation_id === message.conversation_id && m.turn_id === message.turn_id && m.role === message.role);
        if (!duplicate) rows.push({ id: nextId++, user_id: TEST_USER.id, ...message });
      }
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      db[table] = rows.filter((row) => !matches(row));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Nieobsługiwane zapytanie: ${method} ${url}`);
  });
  return db;
}

test("nowa rozmowa zapisuje się bazą zalogowanej osoby; user_id wpisuje baza", async (t) => {
  const db = chatTables(t);
  const owner = testUser();
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  assert.deepEqual(db.violations, []);
  assert.equal(db.conversations.length, 1);
  assert.equal(db.conversations[0].user_id, TEST_USER.id);
  assert.equal(db.conversations[0].chat_id, CHAT_ID);
  assert.equal(db.conversations[0].session_scope, `user:${TEST_USER.id}`);
  assert.equal(db.conversations[0].title, "Gdzie zjeść pierogi?");
  assert.deepEqual(db.messages.map((m) => [m.role, m.content, m.user_id]), [
    ["user", "Gdzie zjeść pierogi?", TEST_USER.id], ["assistant", "Polecam Pierogarnię.", TEST_USER.id],
  ]);
  // Ponowny zapis tej samej tury niczego nie dubluje.
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  assert.equal(db.conversations.length, 1);
  assert.equal(db.messages.length, 2);
  assert.ok(!db.requests.some((r) => r.includes("/rpc/")), "bez funkcji RPC dostępnych tylko dla klucza secret");
});

test("odczyt historii i ostatniej rozmowy filtruje po osobie z sesji", async (t) => {
  const db = chatTables(t);
  const owner = testUser();
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  const chats = await listChats(owner);
  assert.deepEqual(chats.map((c) => [c.chat_id, c.messages[0].count]), [[CHAT_ID, 2]]);
  const latest = await loadLatestChat(owner, CHAT_ID);
  assert.equal(latest.id, CHAT_ID);
  assert.deepEqual(latest.messages.map((m) => [m.role, m.parts[0].text]),
    [["user", "Gdzie zjeść pierogi?"], ["assistant", "Polecam Pierogarnię."]]);
  assert.deepEqual(db.violations, []);
});

test("usuwanie rozmowy: endpoint wymaga sesji i kasuje tylko własne wiersze", async (t) => {
  const db = chatTables(t);
  const owner = testUser();
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  const before = db.requests.length;
  const request = (cookie) => new Request(`http://localhost:3000/api/history?chat=${CHAT_ID}`, {
    method: "DELETE", headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
  });
  assert.equal((await deleteRoute(request(""))).status, 401);
  assert.equal(db.requests.length, before);
  assert.equal((await deleteRoute(request(TEST_AUTH_COOKIE))).status, 204);
  assert.equal(db.conversations.length, 0);
  assert.equal(db.messages.length, 0);
  // Brak rozmowy to nie błąd.
  await deleteChat(owner, CHAT_ID);
  assert.deepEqual(db.violations, []);
});
