const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
Object.assign(process.env, {
  NODE_ENV: "development", VERCEL: "", CHAT_PASSWORD: "test-password",
  SESSION_SECRET: "offline-test-secret-32-characters-long",
  OPENROUTER_API_KEY: "fake-key", OPENROUTER_MODEL: "test/chat-model",
});
const { POST: agent } = require("../app/api/agent/route.ts");
const { createSession, authConfig } = require("../lib/session.ts");
const { generujObraz } = require("../lib/image-generation.ts");
const { publicImageUrlSchema } = require("../lib/image-tool-schema.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=";
const user = { id: "image-user", role: "user", parts: [{ type: "text", text: "Kot w kosmosie" }] };
const request = (body, cookie = "") => new Request("http://localhost:3000/api/agent", {
  method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie },
  body: JSON.stringify(body),
});
const chunks = async (response) => (await response.text()).split("\n").filter((line) => line.startsWith("data: {"))
  .map((line) => JSON.parse(line.slice(6)));

test("agent: sesja jest przed trybem i wejściem; niepoprawny tryb nie uruchamia modeli", async (t) => {
  const fetch = t.mock.method(global, "fetch", async () => { throw new Error("Sieć zablokowana"); });
  for (const body of [null, {}, { mode: "chat" }, { mode: "analyze" }]) {
    assert.equal((await agent(request(body))).status, 401);
  }
  const cookie = `workshop-session=${await createSession(authConfig())}`;
  for (const body of [null, {}, { mode: "image" }, { mode: "chat", messages: [user], model: "override" },
    { mode: "chat", intent: "image", messages: [{ ...user, parts: [{ type: "text", text: "x".repeat(501) }] }] }]) {
    assert.equal((await agent(request(body, cookie))).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("agent: obraz trafia do UI, a do modelu tylko tekst — również w kolejnej turze", async (t) => {
  const calls = [];
  let imageCalls = 0;
  t.mock.method(global, "fetch", async (url, options) => {
    if (String(url) === "https://openrouter.ai/api/v1/images") {
      imageCalls++;
      assert.equal(JSON.parse(options.body).model, "google/gemini-nano-banana-2.1");
      return Response.json({ model: "actual/image-v2", data: [{ b64_json: png }] });
    }
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    calls.push(body);
    const first = calls.length === 1;
    if (first) {
      assert.deepEqual(body.tool_choice, { type: "function", function: { name: "generujObraz" } });
      assert.equal(body.tools.length, 1);
    } else {
      assert.equal(body.messages.find((message) => message.role === "tool").content, "obraz wygenerowany");
      assert.equal(JSON.stringify(body).includes(png), false);
      assert.equal(JSON.stringify(body).includes("data:image/"), false);
    }
    const chunk = { id: `agent-${calls.length}`, model: "actual/chat-model", choices: [{
      index: 0, finish_reason: first ? "tool_calls" : "stop", delta: first ? {
        role: "assistant", tool_calls: [{ index: 0, id: "image-call", type: "function",
          function: { name: "generujObraz", arguments: JSON.stringify({ prompt: "Kot w kosmosie" }) } }],
      } : { role: "assistant", content: "Gotowe." },
    }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const cookie = `workshop-session=${await createSession(authConfig())}`;
  const response = await agent(request({ mode: "chat", intent: "image", messages: [user] }, cookie));
  assert.equal(response.status, 200);
  const stream = await chunks(response);
  assert.equal(stream.some((chunk) => chunk.type === "error"), false);
  const output = stream.find((chunk) => chunk.type === "tool-output-available")?.output;
  assert.equal(output.url, `data:image/png;base64,${png}`);
  assert.equal(output.modelId, "actual/image-v2");
  assert.equal(calls.length, 2);
  assert.equal(imageCalls, 1);
  const assistant = { id: "agent-image-assistant", role: "assistant", parts: [
    { type: "step-start" }, { type: "tool-generujObraz", toolCallId: "image-call", state: "output-available",
      input: { prompt: "Kot w kosmosie" }, output },
    { type: "step-start" }, { type: "text", text: "Gotowe." },
  ] };
  const followup = { id: "next-user", role: "user", parts: [{ type: "text", text: "Dziękuję." }] };
  const next = await agent(request({ mode: "chat", messages: [user, assistant, followup] }, cookie));
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(calls.length, 3);
  assert.equal(imageCalls, 1, "odtwarzanie historii nie generuje nowego obrazu");
});

test("agent: polecenie logo → obejrzenie przez vision → plakat z referencją", async (t) => {
  const logoUrl = "https://assets.example.org/laba-logo.png";
  const calls = [];
  let imageCalls = 0;
  t.mock.method(global, "fetch", async (url, options) => {
    if (String(url) === "https://openrouter.ai/api/v1/images") {
      imageCalls++;
      const input = JSON.parse(options.body);
      assert.deepEqual(input.input_references, [{ type: "image_url", image_url: { url: logoUrl } }]);
      assert.match(input.prompt, /AI Agents/);
      return Response.json({ model: "actual/image-v2", data: [{ b64_json: png }] });
    }
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions", "aplikacja nie pobiera URL obrazu po stronie serwera");
    const body = JSON.parse(options.body);
    calls.push(body);
    const instructions = body.messages[0].content[0].text;
    assert.match(instructions, /Jesteś asystentem AI z narzędziami/);
    assert.doesNotMatch(instructions, /Jesteś asystentem Studio Nova|Kategoria: sales|Na tym etapie odpowiadaj krótkim tekstem/);
    const step = calls.length;
    if (step >= 2) {
      const inspected = body.messages.find((message) => message.role === "tool" && message.name === "obejrzyjObraz");
      assert.ok(inspected.content.some((part) => part.type === "image_url" && part.image_url.url === logoUrl), "vision dostaje rzeczywisty obraz, nie tylko jego opis");
    }
    if (step === 3) {
      const generated = body.messages.find((message) => message.role === "tool" && message.name === "generujObraz");
      assert.equal(generated.content, "obraz wygenerowany");
      assert.equal(JSON.stringify(body).includes(png), false);
    }
    const toolName = step === 1 ? "obejrzyjObraz" : "generujObraz";
    const args = step === 1 ? { url: logoUrl } : {
      prompt: "Plakat AI Agents — 2. edycja, z zachowaniem logo z referencji.", referenceImageUrls: [logoUrl],
    };
    const delta = step === 3 ? { role: "assistant", content: "Gotowe — plakat drugiej edycji." } : {
      role: "assistant",
      content: step === 2 ? "Widzę napis LABA, czarne litery na białym tle." : null,
      ...(step === 1 ? { annotations: [{ type: "url_citation", url_citation: {
        url: "https://laba.example.org/", title: "Oficjalna strona — atrapa testowa",
      } }] } : {}),
      tool_calls: [{ index: 0, id: `logo-step-${step}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
    };
    const chunk = { id: `logo-${step}`, model: "actual/vision-model", choices: [{
      index: 0, finish_reason: step === 3 ? "stop" : "tool_calls", delta,
    }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const cookie = `workshop-session=${await createSession(authConfig())}`;
  const question = { id: "logo-user", role: "user", parts: [{ type: "text",
    text: "Znajdź logo LABA w internecie, upewnij się że to logo LABA opisując co widzisz, a potem zrób mi plakat drugiej edycji kursu AI Agents",
  }] };
  const response = await agent(request({ mode: "chat", messages: [question] }, cookie));
  const stream = await chunks(response);
  assert.equal(stream.some((chunk) => chunk.type === "error"), false);
  const outputs = stream.filter((chunk) => chunk.type === "tool-output-available").map((chunk) => chunk.output);
  assert.equal(outputs[0].url, logoUrl);
  assert.equal(outputs[1].url, `data:image/png;base64,${png}`);
  assert.equal(stream.find((chunk) => chunk.type === "finish").messageMetadata.vision, true);
  assert.equal(calls.length, 3);
  assert.equal(imageCalls, 1);
});

test("referencja wymaga wcześniejszego obejrzenia; adres musi być bezpośrednim obrazem HTTPS", async (t) => {
  const fetch = t.mock.method(global, "fetch", async () => { throw new Error("Nie wolno generować przed obejrzeniem referencji"); });
  const result = await generujObraz.execute({ prompt: "Plakat", referenceImageUrls: ["https://assets.example.org/logo.png"] }, {
    toolCallId: "uninspected", messages: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.komunikat, /Najpierw obejrzyj/);
  assert.equal(fetch.mock.callCount(), 0);
  for (const url of ["not-a-url", "", "http://assets.example.org/logo.png", "https://localhost/logo.png", "https://127.0.0.1/logo.png",
    "https://assets.example.org/logo.svg", "https://assets.example.org/", "https://user:pass@assets.example.org/logo.png"]) {
    assert.equal(publicImageUrlSchema.safeParse(url).success, false);
  }
});
