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

const { installFakeAuth, TEST_AUTH_COOKIE, USER_DB_URL, USER_DB_TOKEN, fakeAuthState, testUser } = require("./fake-auth.cjs");
installFakeAuth();
const { POST } = require("../app/api/misje/route.ts");
const { MISSIONS, publicMissions } = require("../lib/missions.ts");
const { citedNumbers, parseCriteria } = require("../lib/mission-schema.ts");
const { listMissionRuns, loadMissionRun } = require("../lib/mission-runs.ts");
const { findMission } = require("../lib/missions.ts");
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
  // Tylko misja „Notatki ze spotkania” zapisuje wyniki w historii.
  assert.deepEqual([raport.saveRuns, porownanie.saveRuns, spotkanie.saveRuns], [false, false, true]);
  assert.deepEqual(spotkanie.layout.sections.map(section => section.title), ["Ustalenia", "Zadania", "Pytania otwarte"]);
  assert.equal(spotkanie.fields[0].multiline, true);
  // Rozwijany opis: cel, narzędzia, format wyniku i co sprawdzić.
  assert.deepEqual(Object.keys(spotkanie.about), ["goal", "tools", "output", "check"]);
  assert.match(spotkanie.about.check, /brak terminu/);
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

// Atrapa tabeli mission_runs w bazie zalogowanej osoby (PostgREST pod USER_DB_URL).
function missionRunsDb() {
  const db = { inserts: [], reads: [], fail: false, rows: [] };
  db.handle = (url, init) => {
    const headers = new Headers(init.headers);
    // Zawsze token z sesji tej osoby, nigdy klucz secret.
    assert.equal(headers.get("authorization"), `Bearer ${USER_DB_TOKEN}`);
    assert.equal(url.pathname, "/rest/v1/mission_runs");
    const one = headers.get("accept")?.includes("vnd.pgrst.object");
    if (db.fail) return Response.json({ message: "down" }, { status: 500 });
    if ((init.method ?? "GET") === "POST") {
      const body = JSON.parse(init.body);
      db.inserts.push(body);
      assert.equal("user_id" in body, false);
      const row = { id: 42, mission: body.mission, created_at: "2026-11-26T10:00:00+00:00" };
      return Response.json(one ? row : [row], { status: 201 });
    }
    db.reads.push(url.search);
    return Response.json(one ? db.rows[0] ?? null : db.rows);
  };
  return db;
}

test("historia misji: lista 5 ostatnich i odczyt zapisanego wyniku (text albo jsonb)", async (t) => {
  const db = missionRunsDb();
  t.mock.method(global, "fetch", async (input, init = {}) => db.handle(new URL(String(input instanceof Request ? input.url : input)), init));
  const owner = testUser();
  db.rows = [{ id: 7, mission: "spotkanie", created_at: "2026-11-26T09:00:00+00:00" }];
  assert.deepEqual(await listMissionRuns(owner, "spotkanie"), [{ id: "7", mission: "spotkanie", createdAt: "2026-11-26T09:00:00+00:00" }]);
  const query = decodeURIComponent(db.reads.at(-1));
  assert.match(query, /user_id=eq\.11111111-1111-4111-8111-111111111111/);
  assert.match(query, /mission=eq\.spotkanie/);
  assert.match(query, /order=created_at\.desc/);
  assert.match(query, /limit=5/);

  const report = { result: { ustalenia: ["A"], zadania: [{ kto: "Ania", co: "zrobić demo", termin: "do piątku" }], pytania: [] },
    sources: [], completedAt: "2026-11-26T09:00:00.000Z" };
  for (const result of [report, JSON.stringify(report)]) {
    db.rows = [{ id: 7, mission: "spotkanie", input: "Ania: demo do piątku", result, created_at: "2026-11-26T09:00:00+00:00" }];
    const run = await loadMissionRun(owner, "7", findMission);
    assert.equal(run.id, "7");
    assert.equal(run.input, "Ania: demo do piątku");
    assert.deepEqual(run.report.result, report.result);
  }
  // Brak wiersza (np. cudzy: RLS go nie pokazuje) albo wynik niezgodny z układem misji: null.
  db.rows = [];
  assert.equal(await loadMissionRun(owner, "8", findMission), null);
  db.rows = [{ id: 9, mission: "spotkanie", input: "x", result: { result: { zle: 1 }, sources: [], completedAt: report.completedAt }, created_at: "2026-11-26T09:00:00+00:00" }];
  assert.equal(await loadMissionRun(owner, "9", findMission), null);
});

test("endpoint misji z atrapą OpenRouter", async (t) => {
  let calls = [];
  let bodies = [];
  let respond;
  let db = missionRunsDb();
  t.mock.method(global, "fetch", async (input, init = {}) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url);
    if (url.startsWith(USER_DB_URL)) return db.handle(new URL(url), init);
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
    db = missionRunsDb();
    fakeAuthState.stillSignedIn = true;
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
    // Raport niczego nie zapisuje w bazie.
    assert.equal(db.inserts.length, 0);
    assert.equal(body.run, undefined);
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

  await t.test("spotkanie: puste, jedna linia albo za krótkie: 400 bez modelu", async () => {
    reset();
    for (const notatki of ["jedna linia, nawet dość długa, ale tylko jedna", "a\nb", "   \n  "]) {
      const response = await meeting(notatki);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, notatki.trim() ? "lines" : "input");
    }
    assert.equal(calls.length, 0);
  });

  await t.test("spotkanie: tekst nie na temat: agent nie zgaduje, pisze czego brakuje", async () => {
    reset();
    respond = (body) => {
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ["dane_wejsciowe", "ustalenia", "zadania", "pytania"]);
      return completion(JSON.stringify({
        dane_wejsciowe: { wystarczajace: false, czego_brakuje: "To przepis na pierogi, a nie notatki ze spotkania. Wklej notatki z ustaleniami i zadaniami." },
        ustalenia: ["Wymyślone ustalenie."], zadania: [], pytania: [],
      }));
    };
    const response = await meeting("Mąka 500 g\nWoda 250 ml\nSól do smaku, zagnieść ciasto");
    assert.equal(response.status, 422);
    const { error } = await response.json();
    assert.equal(error.code, "needs_input");
    assert.equal(error.detail, "To przepis na pierogi, a nie notatki ze spotkania. Wklej notatki z ustaleniami i zadaniami.");
    assert.equal(db.inserts.length, 0);
  });

  await t.test("spotkanie: jedno wywołanie bez narzędzi; kontrola zadań na serwerze", async () => {
    reset();
    respond = (body) => {
      assert.equal(isResearch(body), false);
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ["dane_wejsciowe", "ustalenia", "zadania", "pytania"]);
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties.zadania.items.properties), ["kto", "co", "termin"]);
      assert.equal(userText(body), `<notatki>\n${notes}\n</notatki>`);
      assert.match(systemText(body), /tylko|WYŁĄCZNIE na wklejonym tekście/);
      return completion(JSON.stringify({
        dane_wejsciowe: { wystarczajace: true, czego_brakuje: "" },
        ustalenia: ["Start kampanii w styczniu, budżet: brak danych."],
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
    // Brak osoby: „brak danych”, brak terminu: „brak terminu”.
    assert.deepEqual(body.result.zadania, [
      { kto: "Ania", co: "przygotować demo", termin: "do piątku" },
      { kto: "Ania", co: "wysłać maila do klienta", termin: "brak terminu" },
      { kto: "brak danych", co: "przygotować budżet", termin: "brak terminu" },
    ]);
    assert.deepEqual(body.result.pytania, ["Jaki jest budżet kampanii?"]);
    assert.deepEqual(body.result.ustalenia, ["Start kampanii w styczniu, budżet: brak danych."]);
    assert.equal("dane_wejsciowe" in body.result, false);
    assert.ok(!Number.isNaN(Date.parse(body.completedAt)));
    // Zapis w historii klientem bazy tej osoby: mission, input, result (user_id wypełnia baza).
    assert.equal(db.inserts.length, 1);
    assert.deepEqual(Object.keys(db.inserts[0]), ["mission", "input", "result"]);
    assert.equal(db.inserts[0].mission, "spotkanie");
    assert.equal(db.inserts[0].input, notes);
    assert.deepEqual(db.inserts[0].result, { result: body.result, sources: [], completedAt: body.completedAt });
    assert.deepEqual(body.run, { id: "42", mission: "spotkanie", createdAt: "2026-11-26T10:00:00+00:00" });
  });

  await t.test("spotkanie: nieudany zapis albo wygasła sesja: wynik jest, z informacją o zapisie", async () => {
    const valid = () => completion(JSON.stringify({ dane_wejsciowe: { wystarczajace: true, czego_brakuje: "" },
      ustalenia: ["A."], zadania: [], pytania: [] }));
    reset();
    db.fail = true;
    respond = valid;
    let body = await (await meeting(notes)).json();
    assert.deepEqual(body.result.ustalenia, ["A."]);
    assert.equal(body.run, undefined);
    assert.match(body.saveError, /Nie udało się zapisać wyniku/);
    reset();
    fakeAuthState.stillSignedIn = false;
    respond = valid;
    body = await (await meeting(notes)).json();
    assert.equal(db.inserts.length, 0);
    assert.match(body.saveError, /Nie udało się zapisać/);
    fakeAuthState.stillSignedIn = true;
  });

  await t.test("spotkanie: puste sekcje są dozwolone, zadanie bez działania odrzucone", async () => {
    reset();
    respond = () => completion(JSON.stringify({ dane_wejsciowe: { wystarczajace: true, czego_brakuje: "" },
      ustalenia: [], zadania: [{ kto: "Jan", co: " ", termin: "jutro" }], pytania: [] }));
    const body = await (await meeting("Spotkanie zespołu, krótko\nomówiliśmy bieżące sprawy")).json();
    assert.deepEqual(body.result, { ustalenia: [], zadania: [], pytania: [] });
  });
});
