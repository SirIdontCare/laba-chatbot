const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
// Klucz secret celowo ustawiony: rozmowy nie mogą z niego korzystać. Model skonfigurowany,
// żeby endpoint czatu doszedł do sprawdzenia rozmowy; każde wyjście do modelu to błąd testu.
Object.assign(process.env, { SUPABASE_URL: "https://secret-db.test", SUPABASE_SECRET_KEY: "offline-secret",
  OPENROUTER_API_KEY: "offline-fake-key", OPENROUTER_MODEL: "test/model", NODE_ENV: "development" });
const { installFakeAuth, testUser, TEST_USER, TEST_AUTH_COOKIE, USER_DB_URL, USER_DB_TOKEN } = require("./fake-auth.cjs");
installFakeAuth();
const { saveChatTurn, loadLatestChat, listChats, deleteChat, claimConversation, discardEmptyConversation } = require("../lib/chat-history.ts");
const { DELETE: deleteRoute } = require("../app/api/history/route.ts");
const { POST: agentRoute } = require("../app/api/agent/route.ts");
const { CHAT_ERRORS } = require("../lib/chat-errors.ts");

const CHAT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_CHAT_ID = "9b2c7d1e-5f3a-4e8b-9c0d-1a2b3c4d5e6f";
const OTHER_USER = "22222222-aaaa-4bbb-8ccc-dddddddddddd";
const question = { id: "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e01", role: "user", parts: [{ type: "text", text: "Gdzie zjeść pierogi?" }] };
const answer = { parts: [{ type: "text", text: "Polecam Pierogarnię." }] };

// Atrapa PostgREST dla conversations i messages, zachowująca się jak baza z RLS:
// - wiersze innej osoby są niewidoczne i nie da się ich zmienić ani usunąć,
// - user_id wpisuje baza (auth.uid() = TEST_USER), kod nie może go wysyłać,
// - unikalny klucz (session_scope, chat_id) obejmuje wiersze wszystkich osób (409 / 23505).
// Każde zapytanie poza bazą użytkownika (klucz secret, model) jest rejestrowane jako naruszenie.
function chatTables(t, { foreign = [] } = {}) {
  const db = { conversations: [], messages: [], requests: [], violations: [], outside: [] };
  let nextId = 1;
  for (const row of foreign) {
    const id = nextId++;
    db.conversations.push({ id, user_id: OTHER_USER, session_scope: "konto", created_at: "2026-11-20T10:00:00Z", ...row.conversation });
    for (const message of row.messages) db.messages.push({ id: nextId++, user_id: OTHER_USER, conversation_id: id, ...message });
  }
  const visible = (row) => row.user_id === TEST_USER.id; // RLS
  t.mock.method(global, "fetch", async (raw, options = {}) => {
    const url = new URL(String(raw instanceof Request ? raw.url : raw));
    const headers = new Headers(options.headers);
    const method = options.method ?? "GET";
    if (url.origin !== USER_DB_URL) { db.outside.push(url.origin); throw new Error(`Sieć zablokowana w testach: ${url.origin}`); }
    db.requests.push(`${method} ${url.pathname}`);
    if (headers.get("authorization") !== `Bearer ${USER_DB_TOKEN}`) db.violations.push("brak tokenu użytkownika");
    const body = options.body ? JSON.parse(options.body) : null;
    for (const row of [body].flat().filter(Boolean)) if ("user_id" in row) db.violations.push("user_id w treści");
    if (method !== "POST" && url.searchParams.get("user_id") !== `eq.${TEST_USER.id}`) db.violations.push(`brak filtra user_id: ${method} ${url.pathname}`);
    const table = url.pathname.replace("/rest/v1/", "");
    const matches = (row) => visible(row) && [...url.searchParams].every(([key, value]) =>
      ["select", "order", "limit", "offset", "on_conflict"].includes(key) || String(row[key]) === value.replace(/^eq\./, ""));
    const reply = (data) => headers.get("accept")?.includes("vnd.pgrst.object") ? Response.json(data[0] ?? null) : Response.json(data);
    if (method === "GET") {
      return reply(db[table].filter(matches).map((row) => table === "conversations"
        ? { ...row, messages: [{ count: db.messages.filter((m) => visible(m) && m.conversation_id === row.id).length }] } : row));
    }
    if (method === "POST" && table === "conversations") {
      if (db.conversations.some((c) => c.session_scope === body.session_scope && c.chat_id === body.chat_id)) {
        return Response.json({ code: "23505", message: "duplicate key value violates unique constraint" }, { status: 409 });
      }
      const row = { id: nextId++, user_id: TEST_USER.id, created_at: new Date().toISOString(), ...body };
      db.conversations.push(row);
      return new Response(null, { status: 201 });
    }
    if (method === "POST" && table === "messages") {
      for (const message of body) {
        const duplicate = db.messages.some((m) => m.conversation_id === message.conversation_id && m.turn_id === message.turn_id && m.role === message.role);
        if (!duplicate) db.messages.push({ id: nextId++, user_id: TEST_USER.id, ...message });
      }
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      db[table] = db[table].filter((row) => !matches(row));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Nieobsługiwane zapytanie: ${method} ${url}`);
  });
  return db;
}

const foreignChat = {
  conversation: { chat_id: OTHER_CHAT_ID, title: "Tajna rozmowa konta A" },
  messages: [{ turn_id: "aaaaaaaa-1111-4222-8333-444444444444", role: "user", content: "Sekret konta A" }],
};

test("nowa rozmowa zapisuje się bazą zalogowanej osoby; user_id wpisuje baza", async (t) => {
  const db = chatTables(t);
  const owner = testUser();
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  assert.deepEqual(db.violations, []);
  assert.equal(db.conversations.length, 1);
  assert.equal(db.conversations[0].user_id, TEST_USER.id);
  assert.equal(db.conversations[0].chat_id, CHAT_ID);
  assert.equal(db.conversations[0].session_scope, "konto");
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
  const db = chatTables(t, { foreign: [foreignChat] });
  const owner = testUser();
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  const chats = await listChats(owner);
  assert.deepEqual(chats.map((c) => [c.chat_id, c.messages[0].count]), [[CHAT_ID, 2]]);
  const latest = await loadLatestChat(owner);
  assert.equal(latest.id, CHAT_ID);
  assert.deepEqual(latest.messages.map((m) => [m.role, m.parts[0].text]),
    [["user", "Gdzie zjeść pierogi?"], ["assistant", "Polecam Pierogarnię."]]);
  assert.deepEqual(db.violations, []);
});

test("cudza rozmowa: odczyt nic nie zwraca, zajęcie i zapis są odrzucane", async (t) => {
  const db = chatTables(t, { foreign: [foreignChat] });
  const owner = testUser();
  assert.equal(await loadLatestChat(owner, OTHER_CHAT_ID), null);
  assert.equal(await claimConversation(owner, OTHER_CHAT_ID, question), "taken");
  await assert.rejects(saveChatTurn(owner, OTHER_CHAT_ID, question, answer, owner.stillSignedIn));
  assert.equal(await deleteChat(owner, OTHER_CHAT_ID), false);
  // Dane konta A bez zmian.
  assert.equal(db.conversations.length, 1);
  assert.deepEqual(db.messages.map((m) => m.content), ["Sekret konta A"]);
  assert.deepEqual(db.violations, []);
});

test("endpoint czatu z cudzym identyfikatorem: 404 przed modelem, bez danych", async (t) => {
  const db = chatTables(t, { foreign: [foreignChat] });
  const response = await agentRoute(new Request("http://localhost:3000/api/agent", {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie: TEST_AUTH_COOKIE },
    body: JSON.stringify({ mode: "chat", chatId: OTHER_CHAT_ID, messages: [question] }),
  }));
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.equal(text, CHAT_ERRORS.notFound);
  assert.doesNotMatch(text, /Sekret|Tajna/);
  assert.deepEqual(db.outside, [], "żadnego zapytania do modelu ani klucza secret");
  assert.equal(db.conversations.length, 1);
  assert.equal(db.messages.length, 1);
});

test("zajęta, ale nieudana nowa rozmowa jest sprzątana i nie pojawia się w historii", async (t) => {
  const db = chatTables(t);
  const owner = testUser();
  assert.equal(await claimConversation(owner, CHAT_ID, question), "created");
  assert.equal(await claimConversation(owner, CHAT_ID, question), "own");
  assert.deepEqual(await listChats(owner), []);
  await discardEmptyConversation(owner, CHAT_ID);
  assert.equal(db.conversations.length, 0);
  // Rozmowa z wiadomościami nie jest usuwana.
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  await discardEmptyConversation(owner, CHAT_ID);
  assert.equal(db.conversations.length, 1);
  assert.deepEqual(db.violations, []);
});

test("usuwanie: endpoint wymaga sesji, kasuje własną rozmowę, cudza daje 404", async (t) => {
  const db = chatTables(t, { foreign: [foreignChat] });
  const owner = testUser();
  await saveChatTurn(owner, CHAT_ID, question, answer, owner.stillSignedIn);
  const before = db.requests.length;
  const request = (chatId, cookie) => new Request(`http://localhost:3000/api/history?chat=${chatId}`, {
    method: "DELETE", headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
  });
  assert.equal((await deleteRoute(request(CHAT_ID, ""))).status, 401);
  assert.equal(db.requests.length, before);
  const foreign = await deleteRoute(request(OTHER_CHAT_ID, TEST_AUTH_COOKIE));
  assert.equal(foreign.status, 404);
  assert.equal(await foreign.text(), CHAT_ERRORS.notFound);
  assert.equal((await deleteRoute(request(CHAT_ID, TEST_AUTH_COOKIE))).status, 204);
  assert.deepEqual(db.conversations.map((c) => c.chat_id), [OTHER_CHAT_ID]);
  assert.deepEqual(db.messages.map((m) => m.content), ["Sekret konta A"]);
  assert.equal((await deleteRoute(request(CHAT_ID, TEST_AUTH_COOKIE))).status, 404);
  assert.deepEqual(db.violations, []);
});
