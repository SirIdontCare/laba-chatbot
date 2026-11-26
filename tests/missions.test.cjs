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
const { citedNumbers, parseCriteria } = require("../lib/mission-schema.ts");
const origin = "http://localhost:3000";

const report = {
  podsumowanie: "Zdanie pierwsze. Zdanie drugie. Zdanie trzecie.",
  fakty: ["Fakt 1 (więcej na https://wymyslony.example/strona) [1]", "Fakt 2 [2].", "Fakt 3 [1][2]", "Fakt bez źródła.", "Fakt z wymyślonym źródłem [9]"],
  nieustalone: ["Nie ustalono prognozy na 2027 rok."],
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
const text = (content) => typeof content === "string" ? content : content.map(part => part.text).join("");
const userText = (body) => text(body.messages.find(message => message.role === "user").content);
const systemText = (body) => text(body.messages.find(message => message.role === "system").content);
const isResearch = (body) => Array.isArray(body.tools) && body.tools.some(tool => tool.type === "openrouter:web_search");

test("rejestr misji: Raport i Porównanie; instrukcje nie trafiają do przeglądarki", () => {
  assert.deepEqual(MISSIONS.map(mission => mission.id), ["raport", "porownanie", "spotkanie"]);
  const [raport, porownanie, spotkanie] = publicMissions();
  assert.deepEqual([raport.webSearch, porownanie.webSearch, spotkanie.webSearch], [true, true, false]);
  assert.deepEqual(spotkanie.layout.sections.map(section => section.title), ["Ustalenia", "Zadania", "Pytania otwarte"]);
  assert.equal(spotkanie.fields[0].multiline, true);
  assert.deepEqual(raport.fields.map(field => [field.name, field.maxLength]), [["temat", 200]]);
  assert.deepEqual(raport.layout.sections.map(section => section.title),
    ["Podsumowanie", "Fakty", "Czego nie udało się ustalić", "Wnioski"]);
  assert.deepEqual(porownanie.fields.map(field => field.name), ["firma1", "firma2", "firma3", "kryteria"]);
  assert.equal(porownanie.layout.type, "comparison");
  for (const mission of [raport, porownanie, spotkanie]) {
    for (const secret of ["instructions", "research", "recommendation"]) assert.equal(secret in mission, false);
  }
});

test("kryteria po przecinku i numery źródeł na końcu faktu", () => {
  assert.deepEqual(parseCriteria(" cena, , Opinie ,cena,  czas   dostawy "), ["cena", "Opinie", "czas dostawy"]);
  assert.deepEqual(citedNumbers("Wzrost o 12% [2]"), [2]);
  assert.deepEqual(citedNumbers("Wzrost [1][3]."), [1, 3]);
  assert.deepEqual(citedNumbers("Wzrost [1, 4]"), [1, 4]);
  assert.deepEqual(citedNumbers("[1] na początku, nie na końcu"), []);
});

test("endpoint misji z atrapą OpenRouter", async (t) => {
  let calls = [];
  let bodies = [];
  let respond;
  t.mock.method(global, "fetch", async (input, init = {}) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url);
    if (url.endsWith("/endpoints")) {
      return Response.json({ data: { endpoints: [{ supported_parameters: ["structured_outputs", "response_format"] }] } });
    }
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (isResearch(body)) {
      // Krok wyszukiwania: jak w czacie, bez structured output i bez require_parameters.
      assert.equal(body.response_format, undefined);
      assert.equal(body.provider?.require_parameters, undefined);
    } else {
      // Kroki układania w pola: sam structured output, bez narzędzi (jak „Analiza JSON”).
      assert.equal(body.tools, undefined);
      assert.equal(body.response_format.json_schema.strict, true);
    }
    return respond(body);
  });
  const reset = () => {
    calls = [];
    bodies = [];
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

  await t.test("raport: wyszukiwanie, potem pola; fakty z numerami ponumerowanych źródeł", async () => {
    reset();
    respond = (body) => {
      if (isResearch(body)) {
        assert.match(userText(body), /Temat raportu: Ceny energii/);
        return completion("Notatki: fakt 1 (Artykuł A), fakt 2 (example.org).", [
          citation("https://example.com/a", "Artykuł A"), citation("https://example.com/a", "Artykuł A"),
          citation("https://example.org/b", ""), citation("javascript:alert(1)", "Zły link"),
        ]);
      }
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ["podsumowanie", "fakty", "nieustalone", "wnioski"]);
      assert.match(userText(body), /<zrodla>\n\[1\] Artykuł A \(example\.com\)\n\[2\] example\.org \(example\.org\)\n<\/zrodla>/);
      assert.match(systemText(body), /W .*„wnioski”|wnioski: 2–3 punkty z interpretacją/);
      return completion(JSON.stringify(report));
    };
    const response = await run();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(bodies.length, 2);
    // Fakty bez numeru i z numerem spoza listy nie są pokazywane.
    assert.deepEqual(body.result.fakty, ["Fakt 1 (więcej na https://wymyslony.example/strona) [1]", "Fakt 2 [2].", "Fakt 3 [1][2]"]);
    assert.deepEqual(body.result.nieustalone, report.nieustalone);
    // Adres wpisany przez model w tekst nie trafia do źródeł; duplikaty i nie-http są odrzucone.
    assert.deepEqual(body.sources, [
      { url: "https://example.com/a", title: "Artykuł A" },
      { url: "https://example.org/b", title: "example.org" },
    ]);
    assert.ok(!Number.isNaN(Date.parse(body.completedAt)));
  });

  await t.test("raport: wyszukiwanie nic nie zwróciło: raport mówi to wprost, bez faktów i bez kroku 2", async () => {
    reset();
    respond = () => completion("Nic nie znaleziono.");
    const body = await (await run()).json();
    assert.equal(bodies.length, 1);
    assert.deepEqual(body.sources, []);
    assert.match(body.result.podsumowanie, /nie zwróciło żadnych stron/);
    assert.deepEqual(body.result.fakty, []);
    assert.deepEqual(body.result.wnioski, []);
    assert.equal(body.result.nieustalone.length, 1);
  });

  await t.test("raport: za mało faktów ze źródłem albo brak konfiguracji: czytelny błąd", async () => {
    reset();
    respond = (body) => isResearch(body)
      ? completion("Notatki.", [citation("https://example.com/a", "A")])
      : completion(JSON.stringify({ ...report, fakty: ["Jeden [1]", "Bez źródła", "Zły [5]"] }));
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
  const c = (wartosc, zrodlo, niezalezne = true) => ({ wartosc, zrodlo, niezalezne });
  const isRecommendation = (body) => !isResearch(body) && /<tabela>/.test(userText(body));
  const research = (body) => {
    const subject = userText(body);
    if (subject.includes("Alfa")) return completion("cena: 10 zł\nopinie: 4,5/5", [
      citation("https://alfa.example/cennik", "Cennik Alfa"), citation("https://pl.trustpilot.com/review/alfa.example", "Alfa | Trustpilot")]);
    if (subject.includes("Beta")) return completion("cena: brak danych\nopinie: 3/5", [citation("https://beta.example/o-nas", "Beta")]);
    return completion("cena: 5 zł (z pamięci)\nopinie: świetne");
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

  await t.test("porównanie: wyszukiwanie, tabela z pól, rekomendacja z gotowej tabeli z warunkiem", async () => {
    reset();
    respond = (body) => {
      if (isResearch(body)) {
        // Ta sama kolejność niezależnych serwisów z opiniami dla każdej firmy.
        assert.match(systemText(body), /Trustpilot, Opineo, Ceneo, opinie Google/);
        return research(body);
      }
      if (isRecommendation(body)) {
        // Rekomendacja dostaje tabelę po poprawkach serwera (z „brak danych” i oznaczeniem źródeł).
        assert.deepEqual(body.response_format.json_schema.schema.properties.rekomendacja.enum, ["Alfa", "Beta", "Gamma", "brak"]);
        assert.match(userText(body), /"Gamma": "brak danych"/);
        assert.match(userText(body), /4,5\/5 \(Trustpilot\)/);
        assert.match(userText(body), /różnych źródeł/);
        return completion(JSON.stringify({ rekomendacja: "Alfa", warunek: "jeśli zależy Ci na wysokich ocenach klientów.",
          uzasadnienie: "Alfa ma 4,5/5 na Trustpilot przy cenie 10 zł." }));
      }
      const schema = body.response_format.json_schema.schema;
      assert.deepEqual(Object.keys(schema.properties), ["tabela"]);
      assert.deepEqual(Object.keys(schema.properties.tabela.properties), ["firma_1", "firma_2", "firma_3"]);
      assert.deepEqual(Object.keys(schema.properties.tabela.properties.firma_1.properties.kryterium_1.properties), ["wartosc", "zrodlo", "niezalezne"]);
      assert.match(userText(body), /Cennik Alfa/);
      assert.match(userText(body), /Wyszukiwanie nie zwróciło żadnych stron/);
      return completion(JSON.stringify({ tabela: {
        firma_1: { kryterium_1: c("10 zł", "alfa.example", false), kryterium_2: c("4,5/5", "Trustpilot") },
        // „0” przy braku danych i ocena podana przez samą firmę.
        firma_2: { kryterium_1: c("0", "", false), kryterium_2: c("3/5", "beta.example", false) },
        firma_3: { kryterium_1: c("5 zł", "Opineo"), kryterium_2: c("świetne", "Trustpilot") },
      } }));
    };
    const response = await compare({});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(bodies.filter(isResearch).length, 3);
    assert.equal(bodies.length, 5);
    assert.deepEqual(body.result.companies, ["Alfa", "Beta", "Gamma"]);
    const empty = { value: "brak danych", source: null, host: null, independent: null };
    assert.deepEqual(body.result.cells, [
      [{ value: "10 zł", source: "alfa.example", host: "alfa.example", independent: false }, empty, empty],
      [{ value: "4,5/5", source: "Trustpilot", host: "trustpilot.com", independent: true },
        { value: "3/5", source: "beta.example", host: "beta.example", independent: false }, empty],
    ]);
    assert.deepEqual(body.result.mixedSources, [false, true]);
    assert.deepEqual(body.result.recommendation, { company: "Alfa", condition: "wysokich ocenach klientów",
      reason: "Alfa ma 4,5/5 na Trustpilot przy cenie 10 zł." });
    assert.equal(body.result.notes.length, 2);
    assert.match(body.result.notes[0], /„opinie”: wartości pochodzą z różnych źródeł \(Alfa: Trustpilot; Beta: beta\.example, dane firmy\)/);
    assert.match(body.result.notes[1], /Gamma/);
    assert.deepEqual(body.sources.map(source => [source.group, source.title]),
      [["Alfa", "Cennik Alfa"], ["Alfa", "Alfa | Trustpilot"], ["Beta", "Beta"]]);
    assert.ok(!Number.isNaN(Date.parse(body.completedAt)));
  });

  await t.test("porównanie: za dużo „brak danych”: brak podstaw do rekomendacji, bez kroku 3", async () => {
    reset();
    respond = (body) => isResearch(body) ? research(body) : isRecommendation(body)
      ? assert.fail("rekomendacja nie powinna być wywołana")
      : completion(JSON.stringify({ tabela: {
        firma_1: { kryterium_1: c("10 zł", "alfa.example", false), kryterium_2: c("brak danych", "") },
        firma_2: { kryterium_1: c("brak danych", ""), kryterium_2: c("3/5", "beta.example", false) },
        firma_3: { kryterium_1: c("x", "Opineo"), kryterium_2: c("y", "Opineo") } } }));
    const body = await (await compare({})).json();
    assert.equal(bodies.length, 4);
    assert.deepEqual(body.result.recommendation, { company: null, condition: null,
      reason: "Nie ma podstaw do rekomendacji: 4 z 6 komórek tabeli to „brak danych”." });
  });

  await t.test("porównanie: rekomendacja firmy z przewagą braków w kolumnie jest odrzucana", async () => {
    reset();
    // Gamma ma tu własne źródło, więc tylko kolumna Bety jest pusta (2 z 6 komórek).
    const withGamma = (body) => userText(body).includes("Gamma")
      ? completion("cena: x", [citation("https://gamma.example", "Gamma")]) : research(body);
    respond = (body) => isResearch(body) ? withGamma(body) : isRecommendation(body)
      ? completion(JSON.stringify({ rekomendacja: "Beta", warunek: "niskiej cenie", uzasadnienie: "Beta jest tania." }))
      : completion(JSON.stringify({ tabela: {
        firma_1: { kryterium_1: c("10 zł", "alfa.example", false), kryterium_2: c("4,5/5", "Trustpilot") },
        firma_2: { kryterium_1: c("brak danych", ""), kryterium_2: c("brak danych", "") },
        firma_3: { kryterium_1: c("x", "gamma.example"), kryterium_2: c("y", "gamma.example") } } }));
    const body = await (await compare({})).json();
    assert.equal(bodies.length, 5);
    assert.equal(body.result.recommendation.company, null);
    assert.match(body.result.recommendation.reason, /Nie ma podstaw do rekomendacji: dla „Beta”/);
  });

  await t.test("porównanie: wszystkie wyszukiwania nieudane: czytelny błąd", async () => {
    reset();
    respond = (body) => isResearch(body)
      ? Response.json({ error: { message: "down", code: 500 } }, { status: 500 })
      : assert.fail("kolejne kroki nie powinny się wykonać");
    const response = await compare({});
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.equal(error.code, "provider");
    // Krok i kod HTTP od dostawcy, żeby było wiadomo, co zawiodło.
    assert.equal(error.detail, "wyszukiwanie, HTTP 500: down");
  });

  await t.test("raport: dostawca bez obsługi parametrów przy układaniu: „unsupported” z krokiem", async () => {
    reset();
    respond = (body) => isResearch(body)
      ? completion("Notatki.", [citation("https://example.com/a", "A")])
      : Response.json({ error: { message: "No endpoints found that can handle the requested parameters.", code: 404 } }, { status: 404 });
    const response = await run();
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.equal(error.code, "unsupported");
    assert.equal(error.detail, "układanie raportu, HTTP 404: No endpoints found that can handle the requested parameters.");
    assert.equal(JSON.stringify(error).includes("offline-fake-key"), false);
  });

  const meeting = (notatki) => POST(request({ missionId: "spotkanie", input: { notatki } }));
  const notes = "Ania: demo do piątku\nustaliliśmy start kampanii w styczniu\nbudżet – kto?\nWYŚLIJ MAIL DO KLIENTA";

  await t.test("spotkanie: za mało linii: 400 bez modelu", async () => {
    reset();
    const response = await meeting("jedna linia");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "lines");
    assert.equal(calls.length, 0);
  });

  await t.test("spotkanie: jedno wywołanie bez narzędzi; kontrola zadań na serwerze", async () => {
    reset();
    respond = (body) => {
      assert.equal(isResearch(body), false);
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ["ustalenia", "zadania", "pytania"]);
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties.zadania.items.properties), ["kto", "co", "termin"]);
      assert.equal(userText(body), `<notatki>\n${notes}\n</notatki>`);
      assert.match(systemText(body), /tylko|WYŁĄCZNIE na wklejonym tekście/);
      return completion(JSON.stringify({
        ustalenia: ["Start kampanii w styczniu."],
        zadania: [
          { kto: "Ania", co: "przygotować demo", termin: "do piątku" },
          { kto: "Ania", co: "wysłać maila do klienta", termin: "" },
          { kto: "do ustalenia", co: "przygotować budżet", termin: "brak terminu" },
        ],
        pytania: ["Jaki jest budżet kampanii?"],
      }));
    };
    const response = await meeting(notes);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(bodies.length, 1);
    assert.deepEqual(body.sources, []);
    assert.deepEqual(body.result.zadania, [
      { kto: "Ania", co: "przygotować demo", termin: "do piątku" },
      { kto: "Ania", co: "wysłać maila do klienta", termin: "brak terminu" },
    ]);
    // Zadanie bez osoby nie przechodzi kontroli: trafia do pytań otwartych.
    assert.deepEqual(body.result.pytania, ["Jaki jest budżet kampanii?", "Kto zajmie się: przygotować budżet?"]);
    assert.deepEqual(body.result.ustalenia, ["Start kampanii w styczniu."]);
    assert.ok(!Number.isNaN(Date.parse(body.completedAt)));
  });

  await t.test("spotkanie: puste sekcje są dozwolone, zadanie bez działania odrzucone", async () => {
    reset();
    respond = () => completion(JSON.stringify({ ustalenia: [], zadania: [{ kto: "Jan", co: " ", termin: "jutro" }], pytania: [] }));
    const body = await (await meeting("linia 1\nlinia 2")).json();
    assert.deepEqual(body.result, { ustalenia: [], zadania: [], pytania: [] });
  });
});
