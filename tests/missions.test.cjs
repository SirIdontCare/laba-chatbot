const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");

// Prawdziwe moduły aplikacji i SDK; bez Next.js, .env i połączeń sieciowych.
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};
process.env.NODE_ENV = "development";

const { installFakeAuth, TEST_AUTH_COOKIE } = require("./fake-auth.cjs");
installFakeAuth();
const { POST } = require("../app/api/misje/route.ts");
const { MISSIONS, publicMissions } = require("../lib/missions.ts");
const origin = "http://localhost:3000";

const report = {
  podsumowanie: "Zdanie pierwsze. Zdanie drugie. Zdanie trzecie.",
  najwazniejsze: ["Fakt 1 (więcej na https://wymyslony.example/strona).", "Fakt 2.", "Fakt 3.", "Fakt 4."],
  wnioski: ["Wniosek 1.", "Wniosek 2."],
};

function completion(content, annotations = []) {
  return new Response(JSON.stringify({
    id: "offline", model: "test/structured-model", created: 1,
    choices: [{ index: 0, message: { role: "assistant", content, annotations }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "Content-Type": "application/json" } });
}
const citation = (url, title) => ({ type: "url_citation", url_citation: { url, title } });

const request = (body, cookie = TEST_AUTH_COOKIE) => new Request(origin + "/api/misje", {
  method: "POST", headers: { origin, "Content-Type": "application/json", cookie }, body: JSON.stringify(body),
});

test("rejestr misji: Raport z polem temat i sekcjami w kolejności; instrukcje nie trafiają do przeglądarki", () => {
  assert.equal(MISSIONS.length, 1);
  const [raport] = publicMissions();
  assert.equal(raport.id, "raport");
  assert.deepEqual(raport.fields.map(field => [field.name, field.maxLength]), [["temat", 200]]);
  assert.deepEqual(raport.sections.map(section => section.title), ["Podsumowanie", "Najważniejsze informacje", "Wnioski"]);
  assert.equal("instructions" in raport, false);
});

test("endpoint misji z atrapą OpenRouter", async (t) => {
  let calls = [];
  let respond;
  t.mock.method(global, "fetch", async (input, init = {}) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url);
    if (url.endsWith("/endpoints")) {
      return Response.json({ data: { endpoints: [{ supported_parameters: ["structured_outputs", "response_format"] }] } });
    }
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    return respond(JSON.parse(init.body));
  });
  const reset = () => {
    calls = [];
    process.env.OPENROUTER_API_KEY = "offline-fake-key";
    process.env.OPENROUTER_MODEL = "test/structured-model";
  };
  const run = (temat = "Ceny energii") => POST(request({ missionId: "raport", input: { temat } }));

  await t.test("bez ciasteczek 401 przed jakimkolwiek wywołaniem", async () => {
    reset();
    assert.equal((await POST(request({ missionId: "raport", input: { temat: "x" } }, ""))).status, 401);
    assert.equal(calls.length, 0);
  });

  await t.test("nieznana misja 404, zły temat 400, bez modelu", async () => {
    reset();
    assert.equal((await POST(request({ missionId: "nie-ma", input: { temat: "x" } }))).status, 404);
    for (const input of [{}, { temat: " " }, { temat: "a".repeat(201) }, { temat: "x", extra: "y" }]) {
      const response = await POST(request({ missionId: "raport", input }));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "input");
    }
    assert.equal(calls.length, 0);
  });

  await t.test("wyszukiwanie w internecie, sekcje sprawdzone, źródła tylko z wyszukiwarki", async () => {
    reset();
    respond = (body) => {
      assert.ok(body.tools.some(tool => tool.type === "openrouter:web_search"));
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ["podsumowanie", "najwazniejsze", "wnioski"]);
      assert.match(JSON.stringify(body.messages), /Temat raportu: Ceny energii/);
      return completion(JSON.stringify(report), [
        citation("https://example.com/a", "Artykuł A"), citation("https://example.com/a", "Artykuł A"),
        citation("https://example.org/b", ""), citation("javascript:alert(1)", "Zły link"),
      ]);
    };
    const response = await run();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result, report);
    // Adres wpisany przez model w tekst nie trafia do źródeł; duplikaty i nie-http są odrzucone.
    assert.deepEqual(body.sources, [
      { url: "https://example.com/a", title: "Artykuł A" },
      { url: "https://example.org/b", title: "example.org" },
    ]);
  });

  await t.test("wyszukiwanie nic nie zwróciło: pusta lista źródeł", async () => {
    reset();
    respond = () => completion(JSON.stringify({ ...report, podsumowanie: "Wyszukiwanie nie zwróciło informacji na ten temat." }));
    const body = await (await run()).json();
    assert.deepEqual(body.sources, []);
  });

  await t.test("zła liczba punktów albo brak konfiguracji: czytelny błąd", async () => {
    reset();
    respond = () => completion(JSON.stringify({ ...report, najwazniejsze: ["Tylko jeden."] }));
    let response = await run();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "invalid_output");
    process.env.OPENROUTER_MODEL = "";
    response = await run();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "configuration");
  });
});
