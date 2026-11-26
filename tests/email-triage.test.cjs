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
const origin = "http://localhost:3000";

const valid = {
  nadawca: "Anna Kowalska", temat: "Cennik", kategoria: "oferta i ceny", priorytet: "średni",
  uzasadnienie: "Klient pyta o ofertę, ale nic nie jest zablokowane.",
  szkic: "Dziękujemy za wiadomość. Sprawdzimy aktualny cennik i wrócimy z odpowiedzią. Czy chodzi o pakiet dla firmy?\nZespół obsługi",
};

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

test("schemat wyniku: enumy, podpis i brak dodatkowych pól", () => {
  assert.equal(triageResultSchema.safeParse(valid).success, true);
  for (const bad of [{ ...valid, kategoria: "sales" }, { ...valid, priorytet: "pilny" },
    { ...valid, szkic: "Dziękujemy." }, { ...valid, extra: 1 }, { ...valid, nadawca: " " }]) {
    assert.equal(triageResultSchema.safeParse(bad).success, false);
  }
});

test("endpoint triage z atrapą OpenRouter", async (t) => {
  let calls = [];
  let respond;
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/endpoints")) {
      return Response.json({ data: { endpoints: [{ supported_parameters: ["structured_outputs", "response_format"] }] } });
    }
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    return respond(JSON.parse(init.body));
  });
  const reset = () => {
    calls = [];
    process.env.OPENROUTER_API_KEY = "offline-fake-key";
    process.env.OPENROUTER_MODEL = "test/structured-model";
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

  await t.test("każdy mail osobno; błąd jednego nie psuje pozostałych", async () => {
    reset();
    respond = (body) => {
      const schema = body.response_format.json_schema.schema;
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(schema.properties.kategoria.enum, ["oferta i ceny", "problem techniczny", "płatności", "reklamacja", "inne"]);
      assert.deepEqual(schema.properties.priorytet.enum, ["wysoki", "średni", "niski"]);
      const mail = body.messages.at(-1).content;
      assert.equal(typeof mail === "string" ? mail : JSON.stringify(mail), mail);
      if (mail.includes("ZEPSUTY")) return completion(JSON.stringify({ ...valid, kategoria: "spam" }));
      return completion(JSON.stringify({ ...valid, temat: mail }));
    };
    const response = await POST(request({ text: "pierwszy\n---\nZEPSUTY\n---\ntrzeci" }));
    assert.equal(response.status, 200);
    const { cards } = await response.json();
    assert.equal(cards.length, 3);
    assert.equal(calls.filter(url => url.endsWith("/chat/completions")).length, 3);
    assert.equal(cards[0].ok, true);
    assert.equal(cards[0].result.temat, "pierwszy");
    assert.equal(cards[1].ok, false);
    assert.equal(cards[1].error.code, "invalid_output");
    assert.equal(cards[2].ok, true);
    assert.equal(cards[2].result.temat, "trzeci");
  });
});
