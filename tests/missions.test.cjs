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
const { parseCriteria } = require("../lib/mission-schema.ts");
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

test("rejestr misji: Raport i Porównanie; instrukcje nie trafiają do przeglądarki", () => {
  assert.deepEqual(MISSIONS.map(mission => mission.id), ["raport", "porownanie"]);
  const [raport, porownanie] = publicMissions();
  assert.deepEqual(raport.fields.map(field => [field.name, field.maxLength]), [["temat", 200]]);
  assert.deepEqual(raport.layout.sections.map(section => section.title), ["Podsumowanie", "Najważniejsze informacje", "Wnioski"]);
  assert.deepEqual(porownanie.fields.map(field => field.name), ["firma1", "firma2", "firma3", "kryteria"]);
  assert.equal(porownanie.layout.type, "comparison");
  for (const mission of [raport, porownanie]) {
    assert.equal("instructions" in mission, false);
    assert.equal("research" in mission, false);
  }
});

test("kryteria po przecinku: bez pustych i powtórzeń", () => {
  assert.deepEqual(parseCriteria(" cena, , Opinie ,cena,  czas   dostawy "), ["cena", "Opinie", "czas dostawy"]);
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

  const compare = (input) => POST(request({ missionId: "porownanie", input: {
    firma1: "Alfa", firma2: "Beta", firma3: "Gamma", kryteria: "cena, opinie", ...input } }));
  const isResearch = (body) => Array.isArray(body.tools) && body.tools.some(tool => tool.type === "openrouter:web_search");
  const userText = (body) => {
    const content = body.messages.find(message => message.role === "user").content;
    return typeof content === "string" ? content : content.map(part => part.text).join("");
  };

  await t.test("porównanie: zła liczba kryteriów albo te same firmy: 400 bez modelu", async () => {
    reset();
    for (const kryteria of ["cena", "cena, cena", "a, b, c, d, e, f"]) {
      const response = await compare({ kryteria });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "criteria");
    }
    const response = await compare({ firma3: "alfa" });
    assert.equal((await response.json()).error.code, "duplicates");
    assert.equal(calls.length, 0);
  });

  await t.test("porównanie: dwa kroki, tabela z pól, brak danych bez zgadywania, źródła z wyszukiwania", async () => {
    reset();
    const bodies = [];
    respond = (body) => {
      bodies.push(body);
      if (isResearch(body)) {
        // Krok 1: bez structured output i bez require_parameters (jak w czacie).
        assert.equal(body.response_format, undefined);
        assert.equal(body.provider?.require_parameters, undefined);
        const text = userText(body);
        if (text.includes("Alfa")) return completion("cena: 10 zł\nopinie: 4,5/5", [citation("https://alfa.example/cennik", "Cennik Alfa")]);
        if (text.includes("Beta")) return completion("cena: brak danych\nopinie: 3/5", [citation("https://beta.example/o-nas", "Beta")]);
        return completion("cena: 5 zł (z pamięci)\nopinie: świetne");
      }
      // Krok 2: sam structured output, bez narzędzi, z notatkami z kroku 1.
      assert.equal(body.tools, undefined);
      assert.equal(body.response_format.json_schema.strict, true);
      const schema = body.response_format.json_schema.schema;
      assert.deepEqual(Object.keys(schema.properties.tabela.properties), ["firma_1", "firma_2", "firma_3"]);
      assert.deepEqual(schema.properties.rekomendacja.enum, ["firma_1", "firma_2", "firma_3", "brak"]);
      assert.match(userText(body), /Cennik Alfa/);
      assert.match(userText(body), /Wyszukiwanie nie zwróciło żadnych stron/);
      return completion(JSON.stringify({
        tabela: {
          firma_1: { kryterium_1: "10 zł", kryterium_2: "4,5/5" },
          firma_2: { kryterium_1: "0", kryterium_2: "3/5" },
          firma_3: { kryterium_1: "5 zł", kryterium_2: "świetne" },
        },
        rekomendacja: "firma_1", uzasadnienie: "Alfa ma najlepsze opinie przy podanej cenie.",
      }));
    };
    const response = await compare({});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(bodies.filter(isResearch).length, 3);
    assert.equal(bodies.length, 4);
    assert.deepEqual(body.result.companies, ["Alfa", "Beta", "Gamma"]);
    assert.deepEqual(body.result.criteria, ["cena", "opinie"]);
    // „0” zamienione na „brak danych”; Gamma bez żadnego źródła: cała kolumna „brak danych”.
    assert.deepEqual(body.result.cells, [["10 zł", "brak danych", "brak danych"], ["4,5/5", "3/5", "brak danych"]]);
    assert.deepEqual(body.result.recommendation, { company: "Alfa", reason: "Alfa ma najlepsze opinie przy podanej cenie." });
    assert.equal(body.result.notes.length, 1);
    assert.match(body.result.notes[0], /Gamma/);
    assert.deepEqual(body.sources, [
      { url: "https://alfa.example/cennik", title: "Cennik Alfa", group: "Alfa" },
      { url: "https://beta.example/o-nas", title: "Beta", group: "Beta" },
    ]);
  });

  await t.test("porównanie: rekomendacja firmy bez źródeł jest odrzucana", async () => {
    reset();
    respond = (body) => {
      if (isResearch(body)) {
        return userText(body).includes("Alfa")
          ? completion("cena: 10 zł", [citation("https://alfa.example", "Alfa")])
          : completion("brak danych");
      }
      return completion(JSON.stringify({
        tabela: { firma_1: { kryterium_1: "10 zł", kryterium_2: "brak danych" },
          firma_2: { kryterium_1: "x", kryterium_2: "y" }, firma_3: { kryterium_1: "x", kryterium_2: "y" } },
        rekomendacja: "firma_3", uzasadnienie: "Gamma jest najlepsza.",
      }));
    };
    const body = await (await compare({})).json();
    assert.equal(body.result.recommendation.company, null);
    assert.match(body.result.recommendation.reason, /Za mało danych/);
  });

  await t.test("porównanie: wszystkie wyszukiwania nieudane: czytelny błąd", async () => {
    reset();
    respond = (body) => isResearch(body)
      ? Response.json({ error: { message: "down", code: 500 } }, { status: 500 })
      : assert.fail("krok 2 nie powinien się wykonać");
    const response = await compare({});
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "provider");
  });
});
