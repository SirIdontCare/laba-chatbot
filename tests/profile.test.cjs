const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
Object.assign(process.env, {
  CHAT_PASSWORD: "profile-test", SESSION_SECRET: "profile-test-secret-at-least-32-characters",
  SUPABASE_URL: "https://profile.test", SUPABASE_SECRET_KEY: "offline-test",
});
const { createSession, authConfig } = require("../lib/session.ts");
const { createProfileTool, loadUserProfile } = require("../lib/user-profile.ts");

test("profil zachowuje polską odmianę i toleruje wielkość liter cytatu", async t => {
  let stored = { name: null, preferences: {} };
  let writes = 0;
  t.mock.method(global, "fetch", async (url, options) => {
    if (String(url).endsWith("/rpc/save_user_profile")) {
      writes++;
      const args = JSON.parse(options.body);
      stored = { name: args.p_name ?? stored.name, preferences: { ...stored.preferences, ...args.p_preferences } };
      return new Response(null, { status: 204 });
    }
    return Response.json([stored]);
  });
  const token = await createSession(authConfig());
  let source = "Cześć jestem Paweł. Lubię pizzę.";
  const tool = createProfileTool(token, () => source);
  const options = { toolCallId: "profile", messages: [] };
  const result = await tool.execute({
    name: { value: "Paweł", quote: "jestem Paweł" },
    preferences: { jedzenie: { value: "pizza", quote: "lubię pizzę" } },
  }, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.zapamietano, { name: "Paweł", jedzenie: "pizza" });
  source = "Wolę krótkie odpowiedzi.";
  assert.equal((await tool.execute({ preferences: {
    styl: { value: "krótkie odpowiedzi", quote: source },
  } }, options)).ok, true);
  assert.deepEqual(await loadUserProfile(), {
    name: "Paweł", preferences: { jedzenie: "pizza", styl: "krótkie odpowiedzi" },
  });
  for (const message of [
    "Czy lubię pizzę?", "Planuję mieszkać w Krakowie.", "To żart, lubię pizzę.",
    'Ktoś powiedział: "lubię pizzę".', "Moje hasło to tajne.", "Nie lubię pizzę.",
  ]) {
    source = message;
    assert.equal((await tool.execute({ preferences: { test: { value: "pizza", quote: message } } }, options)).ok, false);
  }
  source = "Lubię pizzę.";
  assert.equal((await tool.execute({ preferences: {
    test: { value: "pizza", quote: "Lubię sushi." },
  } }, options)).ok, false);
  assert.equal(writes, 2);
});

test("edycja profilu: sesja, origin, zmiana imienia, pojedynczy fakt i czyszczenie", async t => {
  let stored = { name: "Jan", preferences: { miasto: "Kraków", jedzenie: "pizza" } };
  let calls = 0;
  t.mock.method(global, "fetch", async (raw, options) => {
    calls++;
    const url = new URL(String(raw));
    if (url.pathname.endsWith("/rpc/save_user_profile")) {
      const body = JSON.parse(options.body);
      stored.name = body.p_name ?? stored.name;
      return new Response(null, { status: 204 });
    }
    if (options.method === "PATCH") {
      if (url.searchParams.has("preferences")) {
        assert.equal(url.searchParams.get("preferences"), "eq." + JSON.stringify(stored.preferences));
      }
      Object.assign(stored, JSON.parse(options.body));
      return options.headers?.get?.("prefer")?.includes("return=representation")
        ? Response.json([{ singleton: true }]) : Response.json([{ singleton: true }]);
    }
    return Response.json([structuredClone(stored)]);
  });
  const { PATCH } = require("../app/api/profile/route.ts");
  const token = await createSession(authConfig());
  const request = (body, cookie = "", origin = "http://localhost:3000") => new Request("http://localhost:3000/api/profile", {
    method: "PATCH", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await PATCH(request({ action: "clear" }))).status, 401);
  const cookie = "workshop-session=" + token;
  assert.equal((await PATCH(request({ action: "clear" }, cookie, "https://other.test"))).status, 403);
  assert.equal(calls, 0);
  assert.equal((await PATCH(request({ action: "name", value: "Paweł" }, cookie))).status, 204);
  assert.equal(stored.name, "Paweł");
  assert.equal((await PATCH(request({ action: "preference", key: "miasto", value: "Gdańsk" }, cookie))).status, 204);
  assert.deepEqual(stored.preferences, { miasto: "Gdańsk", jedzenie: "pizza" });
  assert.equal((await PATCH(request({ action: "preference", key: "jedzenie", value: null }, cookie))).status, 204);
  assert.deepEqual(stored.preferences, { miasto: "Gdańsk" });
  assert.equal((await PATCH(request({ action: "name", value: null }, cookie))).status, 204);
  assert.equal(stored.name, null);
  assert.equal((await PATCH(request({ action: "clear" }, cookie))).status, 204);
  assert.deepEqual(stored, { name: null, preferences: {} });
});

test("wyliczenie czterech preferencji zapisuje cztery krótkie wartości", async t => {
  const writes = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    writes.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  });
  const token = await createSession(authConfig());
  const source = "lubie jazdę na rowerze, pizze kanadyjską, grę na gitarze oraz kodowanie agentyczne";
  const preferences = {
    ulubiona_pizza: "pizza kanadyjska", hobby_kodowanie: "kodowanie agentyczne",
    hobby_gra_na_gitarze: "gra na gitarze", hobby_jazda_na_rowerze: "jazda na rowerze",
  };
  const tool = createProfileTool(token, () => source);
  const result = await tool.execute({ preferences: Object.fromEntries(
    Object.entries(preferences).map(([key, value]) => [key, { value, quote: source }]),
  ) }, { toolCallId: "list", messages: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(writes[0].p_preferences, preferences);
  const rejected = await tool.execute({ preferences: {
    ulubiona_pizza: { value: source, quote: source },
  } }, { toolCallId: "bad-list", messages: [] });
  assert.equal(rejected.ok, false);
  assert.equal(writes.length, 1);
});
