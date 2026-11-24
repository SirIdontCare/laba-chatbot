const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
// Klucz secret celowo ustawiony: profil nie może z niego korzystać.
Object.assign(process.env, { SUPABASE_URL: "https://secret-db.test", SUPABASE_SECRET_KEY: "offline-secret" });
const { installFakeAuth, testUser, TEST_USER, TEST_AUTH_COOKIE, USER_DB_URL, USER_DB_TOKEN } = require("./fake-auth.cjs");
installFakeAuth();
const { createProfileTool, loadUserProfile } = require("../lib/user-profile.ts");

// Atrapa tabeli user_profiles w PostgREST widzianej przez RLS: tylko wiersz zalogowanej osoby.
// Sprawdza, że każde zapytanie idzie bazą użytkownika z jego tokenem, nigdy kluczem secret,
// i że kod nie wysyła kolumny user_id (wypełnia ją baza).
function profileTable(t, initial = null) {
  const state = { row: initial && structuredClone(initial), writes: [], calls: 0 };
  t.mock.method(global, "fetch", async (raw, options = {}) => {
    state.calls++;
    const url = new URL(String(raw instanceof Request ? raw.url : raw));
    const headers = new Headers(options.headers);
    const method = options.method ?? "GET";
    assert.equal(url.origin, USER_DB_URL);
    assert.equal(headers.get("authorization"), `Bearer ${USER_DB_TOKEN}`);
    assert.equal(url.pathname, "/rest/v1/user_profiles");
    if (method !== "POST") assert.equal(url.searchParams.get("user_id"), `eq.${TEST_USER.id}`);
    if (options.body) assert.equal("user_id" in JSON.parse(options.body), false);
    if (method === "GET") return Response.json(state.row ? [structuredClone(state.row)] : []);
    if (method === "POST") {
      // Pusty profil, jeśli go nie ma: insert ... on conflict (user_id) do nothing.
      assert.equal(url.searchParams.get("on_conflict"), "user_id");
      assert.match(headers.get("prefer") ?? "", /resolution=ignore-duplicates/);
      state.row ??= { name: null, preferences: {} };
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      if (url.searchParams.get("preferences") !== "eq." + JSON.stringify(state.row.preferences)) return Response.json([]);
      const body = JSON.parse(options.body);
      Object.assign(state.row, body);
      state.writes.push(structuredClone(body));
      return Response.json([{ user_id: TEST_USER.id }]);
    }
    throw new Error(`Nieobsługiwane zapytanie: ${method} ${url}`);
  });
  return state;
}

test("profil zachowuje polską odmianę i toleruje wielkość liter cytatu", async t => {
  const table = profileTable(t);
  const owner = testUser();
  let source = "Cześć jestem Paweł. Lubię pizzę.";
  const tool = createProfileTool(owner, () => source);
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
  assert.deepEqual(await loadUserProfile(owner), {
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
  assert.equal(table.writes.length, 2);
});

test("narzędzie profilu bez zalogowanej osoby lub po wylogowaniu niczego nie zapisuje", async t => {
  const table = profileTable(t);
  const source = "Mam na imię Ola.";
  const input = { name: { value: "Ola", quote: "Mam na imię Ola" } };
  const options = { toolCallId: "no-owner", messages: [] };
  assert.equal((await createProfileTool(null, () => source).execute(input, options)).ok, false);
  const signedOut = { ...testUser(), stillSignedIn: async () => false };
  assert.equal((await createProfileTool(signedOut, () => source).execute(input, options)).ok, false);
  assert.equal(table.calls, 0);
});

test("edycja profilu: sesja, origin, zmiana imienia, pojedynczy fakt i czyszczenie", async t => {
  const table = profileTable(t, { name: "Jan", preferences: { miasto: "Kraków", jedzenie: "pizza" } });
  const { PATCH } = require("../app/api/profile/route.ts");
  const request = (body, cookie = "", origin = "http://localhost:3000") => new Request("http://localhost:3000/api/profile", {
    method: "PATCH", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await PATCH(request({ action: "clear" }))).status, 401);
  const cookie = TEST_AUTH_COOKIE;
  assert.equal((await PATCH(request({ action: "clear" }, cookie, "https://other.test"))).status, 403);
  // Próba podania cudzego identyfikatora w treści jest odrzucana jako nieprawidłowe dane.
  assert.equal((await PATCH(request({ action: "clear", user_id: "someone-else" }, cookie))).status, 400);
  assert.equal(table.calls, 0);
  assert.equal((await PATCH(request({ action: "name", value: "Paweł" }, cookie))).status, 204);
  assert.equal(table.row.name, "Paweł");
  assert.equal((await PATCH(request({ action: "preference", key: "miasto", value: "Gdańsk" }, cookie))).status, 204);
  assert.deepEqual(table.row.preferences, { miasto: "Gdańsk", jedzenie: "pizza" });
  assert.equal((await PATCH(request({ action: "preference", key: "jedzenie", value: null }, cookie))).status, 204);
  assert.deepEqual(table.row.preferences, { miasto: "Gdańsk" });
  assert.equal((await PATCH(request({ action: "name", value: null }, cookie))).status, 204);
  assert.equal(table.row.name, null);
  assert.equal((await PATCH(request({ action: "clear" }, cookie))).status, 204);
  assert.deepEqual(table.row, { name: null, preferences: {} });
});

test("wyliczenie czterech preferencji zapisuje cztery krótkie wartości", async t => {
  const table = profileTable(t);
  const source = "lubie jazdę na rowerze, pizze kanadyjską, grę na gitarze oraz kodowanie agentyczne";
  const preferences = {
    ulubiona_pizza: "pizza kanadyjska", hobby_kodowanie: "kodowanie agentyczne",
    hobby_gra_na_gitarze: "gra na gitarze", hobby_jazda_na_rowerze: "jazda na rowerze",
  };
  const tool = createProfileTool(testUser(), () => source);
  const result = await tool.execute({ preferences: Object.fromEntries(
    Object.entries(preferences).map(([key, value]) => [key, { value, quote: source }]),
  ) }, { toolCallId: "list", messages: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(table.writes[0].preferences, preferences);
  const rejected = await tool.execute({ preferences: {
    ulubiona_pizza: { value: source, quote: source },
  } }, { toolCallId: "bad-list", messages: [] });
  assert.equal(rejected.ok, false);
  assert.equal(table.writes.length, 1);
});

test("krótkie cytaty w wyliczeniu dziedziczą deklarację lubię z tego samego zdania", async t => {
  const table = profileTable(t);
  let source = "lubię włochy, prowdzić kursy, jeżdzić na wycieczki oraz trening siłowy";
  const tool = createProfileTool(testUser(), () => source);
  const preferences = {
    ulubiony_kraj: { value: "Włochy", quote: "włochy" },
    hobby_kursy: { value: "prowadzić kursy", quote: "prowdzić kursy" },
    hobby_wycieczki: { value: "jeździć na wycieczki", quote: "jeżdzić na wycieczki" },
    hobby_trening: { value: "trening siłowy", quote: "trening siłowy" },
  };
  const result = await tool.execute({ preferences }, { toolCallId: "short-quotes", messages: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(table.writes[0].preferences, Object.fromEntries(
    Object.entries(preferences).map(([key, item]) => [key, item.value]),
  ));
  source = "Lubię pizzę. Kolega lubi Włochy.";
  assert.equal((await tool.execute({ preferences: {
    ulubiony_kraj: { value: "Włochy", quote: "Włochy" },
  } }, { toolCallId: "third-party", messages: [] })).ok, false);
  assert.equal(table.writes.length, 1);
});

test("trzy preferencje: pytania o braki i zapis krótkich odpowiedzi w kontekście", async t => {
  const { profileFollowUp } = require("../lib/user-profile.ts");
  assert.match(profileFollowUp({}), /W jakim mieście mieszkasz/);
  assert.match(profileFollowUp({ miasto: "Kraków" }), /Jakie jest Twoje ulubione danie/);
  assert.match(profileFollowUp({ miasto: "Kraków", ulubione_danie: "pierogi" }), /Jaki środek transportu preferujesz/);
  assert.match(profileFollowUp({ miasto: "Kraków", ulubione_danie: "pierogi", preferowany_transport: "pociąg" }), /Nie pytaj/);
  const table = profileTable(t);
  let source = "Kraków";
  let previous = "W jakim mieście mieszkasz?";
  const tool = createProfileTool(testUser(), () => source, () => previous);
  for (const [key, value, question] of [
    ["miasto", "Kraków", "W jakim mieście mieszkasz?"],
    ["ulubione_danie", "pierogi", "Jakie jest Twoje ulubione danie?"],
    ["preferowany_transport", "pociąg", "Jaki środek transportu preferujesz?"],
  ]) {
    source = value; previous = question;
    assert.equal((await tool.execute({ preferences: { [key]: { value, quote: value } } },
      { toolCallId: key, messages: [] })).ok, true);
    assert.equal(table.writes.at(-1).preferences[key], value);
  }
  // Kolejne fakty dopisują się do profilu, nie zastępują poprzednich.
  assert.deepEqual(table.row.preferences, { miasto: "Kraków", ulubione_danie: "pierogi", preferowany_transport: "pociąg" });
  previous = "Jaki środek transportu preferujesz?";
  source = "nie wiem";
  assert.equal((await tool.execute({ preferences: { preferowany_transport: {
    value: source, quote: source,
  } } }, { toolCallId: "decline", messages: [] })).ok, false);
  source = "Kraków"; previous = "Opisz mi miasto.";
  assert.equal((await tool.execute({ preferences: { miasto: { value: source, quote: source } } },
    { toolCallId: "no-question", messages: [] })).ok, false);
  assert.equal(table.writes.length, 3);
});
