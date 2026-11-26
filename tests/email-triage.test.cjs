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
const { splitEmails, triageResultSchema } = require("../lib/email-triage-schema.ts");
const { POST } = require("../app/api/email-triage/route.ts");
const { knowledgeQuery } = require("../lib/email-triage.ts");
const { USER_DB_URL } = require("./fake-auth.cjs");
const { EMBEDDING_DIMENSIONS } = require("../lib/model.ts");
const origin = "http://localhost:3000";

const valid = {
  nadawca: "Anna Kowalska", temat: "Cennik", kategoria: "oferta i ceny", priorytet: "średni",
  uzasadnienie: "Klient pyta o ofertę, ale nic nie jest zablokowane.",
  szkic: "Dziękujemy za wiadomość. Sprawdzimy aktualny cennik i wrócimy z odpowiedzią. Czy chodzi o pakiet dla firmy?\nZespół obsługi",
};

const modelValid = { ...valid, zrodla: [] };

function toolCall(name, args) {
  return new Response(JSON.stringify({
    id: "offline-tool", model: "test/structured-model", created: 1,
    choices: [{ index: 0, message: { role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "Content-Type": "application/json" } });
}

function completion(content) {
  return new Response(JSON.stringify({
    id: "offline", model: "test/structured-model", created: 1,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "Content-Type": "application/json" } });
}

const request = (body, cookie = TEST_AUTH_COOKIE) => new Request(origin + "/api/email-triage", {
  method: "POST", headers: { origin, "Content-Type": "application/json", cookie }, body: JSON.stringify(body),
});

test("podział maili po linii z trzema myślnikami", () => {
  assert.deepEqual(splitEmails("a\n---\nb\r\n  ---  \r\nc\n---\n\n---\n"), ["a", "b", "c"]);
  assert.deepEqual(splitEmails("tekst --- w środku linii"), ["tekst --- w środku linii"]);
  assert.deepEqual(splitEmails("   "), []);
});

test("zapytanie do bazy wiedzy z tematu i treści, bez nagłówków", () => {
  const query = knowledgeQuery("Od: Anna <a@example.com>\nTemat: Cena konsultacji\n\nIle kosztuje konsultacja online?");
  assert.equal(query, "Cena konsultacji Ile kosztuje konsultacja online?");
  assert.equal(knowledgeQuery("x".repeat(900)).length, 500);
});

test("schemat wyniku: enumy, podpis i brak dodatkowych pól", () => {
  assert.equal(triageResultSchema.safeParse(valid).success, true);
  assert.equal(triageResultSchema.safeParse({ ...valid, kategoria: "konsultacje i terminy" }).success, true);
  for (const bad of [{ ...valid, kategoria: "sales" }, { ...valid, kategoria: "reklamacja" }, { ...valid, priorytet: "pilny" },
    { ...valid, szkic: "Dziękujemy." }, { ...valid, extra: 1 }, { ...valid, nadawca: " " }]) {
    assert.equal(triageResultSchema.safeParse(bad).success, false);
  }
});

test("endpoint triage z atrapą OpenRouter i bazy wiedzy", async (t) => {
  let calls = [];
  let respond;
  let rpcReply;
  t.mock.method(global, "fetch", async (input, init = {}) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url);
    if (url.endsWith("/endpoints")) {
      return Response.json({ data: { endpoints: [{ supported_parameters: ["structured_outputs", "response_format"] }] } });
    }
    if (url === "https://openrouter.ai/api/v1/embeddings") {
      return Response.json({ object: "list", model: "test/embedding-model",
        data: [{ object: "embedding", index: 0, embedding: Array(EMBEDDING_DIMENSIONS).fill(0.01) }] });
    }
    if (url === `${USER_DB_URL}/rest/v1/rpc/match_chunks`) return rpcReply();
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    return respond(JSON.parse(init.body));
  });
  const reset = () => {
    calls = [];
    process.env.OPENROUTER_API_KEY = "offline-fake-key";
    process.env.OPENROUTER_MODEL = "test/structured-model";
    process.env.OPENROUTER_EMBEDDING_MODEL = "test/embedding-model";
    rpcReply = () => Response.json([
      { document_id: 1, title: "Cennik 2026", content: "Pakiet Start kosztuje 490 zł netto miesięcznie.", similarity: 0.7 },
    ]);
  };
  const userText = (body) => {
    const content = body.messages.find(message => message.role === "user").content;
    return typeof content === "string" ? content : content.map(part => part.text).join("");
  };
  const mailOf = (body) => userText(body).match(/<mail>\n([\s\S]*?)\n<\/mail>/)[1];
  // Bazę wiedzy przeszukuje serwer przed wywołaniem modelu; model dostaje sam structured output,
  // bez narzędzi (ten sam kształt zapytania co „Analiza JSON”).
  const agent = (final) => (body) => {
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.parallel_tool_calls, undefined);
    assert.match(userText(body), /<baza_wiedzy>/);
    return completion(JSON.stringify(final(mailOf(body))));
  };

  await t.test("bez ciasteczek 401 przed jakimkolwiek wywołaniem", async () => {
    reset();
    assert.equal((await POST(request({ text: "mail" }, ""))).status, 401);
    assert.equal(calls.length, 0);
  });

  await t.test("więcej niż 10 maili: 400 bez modelu", async () => {
    reset();
    const response = await POST(request({ text: Array.from({ length: 11 }, (_, i) => `mail ${i}`).join("\n---\n") }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "tooMany");
    assert.equal(calls.length, 0);
  });

  await t.test("najpierw baza wiedzy, potem wynik; błąd jednego maila nie psuje pozostałych", async () => {
    reset();
    let checkedSchema = false;
    respond = (body) => {
      if (!checkedSchema) {
        assert.match(userText(body), /Pakiet Start kosztuje 490 zł/);
        const schema = body.response_format.json_schema.schema;
        assert.equal(body.response_format.json_schema.strict, true);
        assert.deepEqual(schema.properties.kategoria.enum, ["konsultacje i terminy", "oferta i ceny", "płatności i faktury", "problem techniczny", "inne"]);
        assert.deepEqual(schema.properties.priorytet.enum, ["wysoki", "średni", "niski"]);
        // Zasady priorytetu Studio Nova i bieżący czas trafiają do instrukcji modelu.
        const content = body.messages.find(message => message.role === "system").content;
        const system = typeof content === "string" ? content : content.map(part => part.text).join("");
        assert.match(system, /opłaconą konsultację, która zaczyna się\s+w ciągu 24 godzin/);
        assert.match(system, /niski = podziękowania, opinie, reklamy i newslettery/);
        assert.match(system, /Czas sortowania: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
        checkedSchema = true;
      }
      return agent((mail) => mail.includes("ZEPSUTY")
        ? { ...modelValid, kategoria: "spam" }
        // Model podaje też tytuł, którego wyszukiwanie nie zwróciło: serwer go odrzuca.
        : { ...modelValid, temat: mail, zrodla: ["Cennik 2026", "Wymyślony dokument"] })(body);
    };
    const response = await POST(request({ text: "pierwszy\n---\nZEPSUTY\n---\ntrzeci" }));
    assert.equal(response.status, 200);
    const { cards } = await response.json();
    assert.equal(checkedSchema, true);
    assert.equal(cards.length, 3);
    assert.equal(calls.filter(url => url.endsWith("/chat/completions")).length, 3);
    assert.equal(calls.filter(url => url.endsWith("/rpc/match_chunks")).length, 3);
    assert.equal(cards[0].ok, true);
    assert.equal(cards[0].result.temat, "pierwszy");
    assert.deepEqual(cards[0].sources, ["Cennik 2026"]);
    assert.equal("zrodla" in cards[0].result, false);
    assert.equal(cards[0].knowledgeNote, undefined);
    assert.equal(cards[1].ok, false);
    assert.equal(cards[1].error.code, "invalid_output");
    assert.equal(cards[2].ok, true);
    assert.equal(cards[2].result.temat, "trzeci");
  });

  await t.test("baza wiedzy niedostępna: wynik bez źródeł, z informacją", async () => {
    reset();
    rpcReply = () => Response.json({ message: "down" }, { status: 500 });
    respond = (body) => {
      assert.match(userText(body), /Nie udało się sprawdzić bazy wiedzy\./);
      return agent(() => ({ ...modelValid, zrodla: ["Cennik 2026"],
      szkic: "Dziękujemy za pytanie. Cena pakietu: [DO UZUPEŁNIENIA: cena pakietu Start].\nZespół obsługi" }))(body);
    };
    const { cards } = await (await POST(request({ text: "Ile kosztuje pakiet Start?" }))).json();
    assert.equal(cards[0].ok, true);
    assert.deepEqual(cards[0].sources, []);
    assert.match(cards[0].knowledgeNote, /Nie udało się sprawdzić bazy wiedzy/);
    assert.match(cards[0].result.szkic, /\[DO UZUPEŁNIENIA: cena pakietu Start\]/);
  });
});
