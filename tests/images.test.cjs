const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
Object.assign(process.env, {
  NODE_ENV: "development", VERCEL: "", VERCEL_PROJECT_PRODUCTION_URL: "",
  SESSION_SECRET: "offline-test-secret-32-characters-long",
  OPENROUTER_API_KEY: "offline-test-key", OPENROUTER_MODEL: "configured/vision-model",
});
const { installFakeAuth, TEST_AUTH_COOKIE } = require("./fake-auth.cjs");
installFakeAuth();
const { generujObraz } = require("../lib/image-generation.ts");
const { POST: chat } = require("../app/api/agent/route.ts");
const { IMAGE_MESSAGES, MAX_PHOTO_BYTES, photoSelectionError } = require("../lib/image-input.ts");
const { conversationForModel } = require("../lib/chat-message.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=";
const photo = { type: "file", mediaType: "image/png", filename: "test.png", url: `data:image/png;base64,${png}` };
const request = (path, body, cookie = "", origin = "http://localhost:3000") => new Request(`http://localhost:3000${path}`, {
  method: "POST", headers: { origin, "content-type": "application/json", cookie }, body: JSON.stringify(path === "/api/agent" ? { ...body, mode: "chat" } : body),
});
const sessionCookie = async () => TEST_AUTH_COOKIE;
const userMessage = (parts) => ({ id: "media-user", role: "user", parts });
const parseStream = async (response) => (await response.text()).split("\n")
  .filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
const imageRequest = (prompt, cookie = "", origin) => request("/api/agent", {
  intent: "image", messages: [userMessage([{ type: "text", text: prompt }])],
}, cookie, origin);
const generate = (prompt) => generujObraz.execute({ prompt }, { toolCallId: "offline-image", messages: [] });

test("obrazy: sesja i walidacja przed modelem", async (t) => {
  const blocked = t.mock.method(global, "fetch", async () => { throw new Error("Sieć zablokowana"); });
  assert.equal((await chat(imageRequest("obraz"))).status, 401);
  assert.equal((await chat(request("/api/agent", null))).status, 401);
  const cookie = await sessionCookie();
  assert.equal((await chat(imageRequest("obraz", cookie, "https://other.test"))).status, 403);
  for (const prompt of [undefined, "", "   ", "x".repeat(501), 123]) {
    assert.equal((await chat(imageRequest(prompt, cookie))).status, 400);
  }
  for (const invalid of [
    { ...photo, url: "https://example.com/image.png" },
    { ...photo, mediaType: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zy8+" },
    { ...photo, url: "data:image/png;base64,bm90LWFuLWltYWdl" },
    { ...photo, url: "data:image/png;base64," + Buffer.alloc(MAX_PHOTO_BYTES + 1).toString("base64") },
    { ...photo, mediaType: "image/jpeg" },
  ]) {
    assert.equal((await chat(request("/api/agent", { messages: [userMessage([invalid])] }, cookie))).status, 400);
  }
  assert.equal((await chat(request("/api/agent", { messages: [userMessage([photo, photo])] }, cookie))).status, 400);
  assert.equal(blocked.mock.callCount(), 0);
  assert.equal(photoSelectionError({ type: "image/png", size: MAX_PHOTO_BYTES }), undefined);
  assert.equal(photoSelectionError({ type: "image/png", size: MAX_PHOTO_BYTES + 1 }), IMAGE_MESSAGES.invalidPhoto);
  assert.equal(photoSelectionError({ type: "image/gif", size: 100 }), IMAGE_MESSAGES.invalidPhoto);
});

test("narzędzie generowania: generateImage i rzeczywisty model z API", async (t) => {
  const calls = [];
  let omitModel = false;
  t.mock.method(global, "fetch", async (url, options) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/images");
    calls.push(JSON.parse(options.body));
    return Response.json({ data: [{ b64_json: png }], ...(omitModel ? {} : { model: "actual/image-model-v2" }) });
  });
  const result = await generate("x".repeat(500));
  assert.deepEqual(result, { ok: true, url: photo.url, mediaType: "image/png", modelId: "actual/image-model-v2" });
  assert.equal(calls[0].model, "google/gemini-nano-banana-2.1");
  assert.equal(calls[0].prompt.length, 500);
  assert.equal(calls[0].n, 1);
  omitModel = true;
  const noModel = await generate("Kot");
  assert.equal(noModel.modelId, null, "nie pokazujemy żądanego modelu jako faktycznie użytego");
});

test("generowanie: niedostępny model i brak obrazu dają polski komunikat", async (t) => {
  for (const scenario of ["unavailable", "empty", "network"]) {
    await t.test(scenario, async (t) => {
      t.mock.method(global, "fetch", async () => {
        if (scenario === "network") throw new TypeError("Network failure");
        return scenario === "empty" ? Response.json({ data: [] }) : Response.json({
          error: { code: 404, message: "No endpoints found" },
        }, { status: 404 });
      });
      const result = await generate("Kot");
      assert.equal(result.ok, false);
      assert.equal(result.komunikat, IMAGE_MESSAGES.unavailable);
    });
  }
});

test("vision: zdjęcie jako file, faktyczny model i dalsza rozmowa", async (t) => {
  const cookie = await sessionCookie();
  const calls = [];
  let omitModel = false;
  t.mock.method(global, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const chunk = { id: "vision-response", ...(omitModel ? {} : { model: "actual/vision-model-v3" }),
      choices: [{ index: 0, finish_reason: "stop", delta: { role: "assistant", content: "Widzę zdjęcie." } }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  const user = userMessage([photo]);
  const response = await chat(request("/api/agent", { messages: [user] }, cookie));
  assert.equal(response.status, 200);
  const chunks = await parseStream(response);
  assert.equal(chunks.some((chunk) => chunk.type === "error"), false);
  const metadata = chunks.find((chunk) => chunk.type === "finish").messageMetadata;
  assert.equal(metadata.vision, true);
  assert.equal(metadata.modelId, "actual/vision-model-v3");
  assert.ok(calls[0].messages.find((message) => message.role === "user").content
    .some((part) => part.type === "image_url" && part.image_url.url === photo.url));
  const assistant = { id: "vision-assistant", role: "assistant", metadata, parts: [{ type: "text", text: "Widzę zdjęcie." }] };
  omitModel = true;
  const followup = userMessage([{ type: "text", text: "Opisz je dokładniej." }]);
  followup.id = "vision-next";
  const next = await chat(request("/api/agent", { messages: [user, assistant, followup] }, cookie));
  assert.equal(next.status, 200);
  const nextMetadata = (await parseStream(next)).find((chunk) => chunk.type === "finish").messageMetadata;
  assert.equal(nextMetadata.vision, true);
  assert.equal(nextMetadata.modelId, null);
  assert.equal(conversationForModel([user, assistant,
    { id: "generated", role: "assistant", metadata: { kind: "image-generation", modelId: "actual/image-model" }, parts: [photo] },
  ]).length, 2);
});

test("vision: model bez obsługi obrazów daje czytelny błąd w strumieniu", async (t) => {
  const cookie = await sessionCookie();
  t.mock.method(global, "fetch", async () => Response.json({ error: { message: "Unsupported image input", code: 400 } }, { status: 400 }));
  const response = await chat(request("/api/agent", { messages: [userMessage([photo])] }, cookie));
  const error = (await parseStream(response)).find((chunk) => chunk.type === "error");
  assert.ok(error?.errorText.includes("nie obsługiwać obrazów"));
  assert.equal(error?.errorText.includes("Unsupported image input"), false);
});
