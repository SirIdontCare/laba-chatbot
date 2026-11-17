const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");

// Prawdziwy endpoint i provider, symulowana sieć; bez odczytu plików .env.
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};
Object.assign(process.env, {
  NODE_ENV: "development", VERCEL: "", VERCEL_PROJECT_PRODUCTION_URL: "",
  CHAT_PASSWORD: "test-workshop-password",
  SESSION_SECRET: "offline-test-secret-32-characters-long",
  OPENROUTER_API_KEY: "test-key", OPENROUTER_MODEL: "google/test-model",
});
const { POST: login } = require("../app/api/auth/login/route.ts");
const { POST: chat } = require("../app/api/agent/route.ts");
const { warsawTime } = require("../lib/chat-tools.ts");
const { fetchWeather } = require("../lib/weather-tool.ts");
const request = (path, body, cookie = "") => new Request(`http://localhost:3000${path}`, {
  method: "POST",
  headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie },
  body: JSON.stringify(path === "/api/agent" ? { ...body, mode: "chat" } : body),
});

test("czas warszawski: północ i przejście na czas letni", () => {
  assert.deepEqual(warsawTime(new Date("2026-11-10T23:30:00Z")), {
    data: "2026-11-11", dzienTygodnia: "środa", godzina: "00:30:00", strefa: "Europe/Warsaw",
  });
  assert.equal(warsawTime(new Date("2026-03-29T00:59:00Z")).godzina, "01:59:00");
  assert.equal(warsawTime(new Date("2026-03-29T01:00:00Z")).godzina, "03:00:00");
});

test("aktualnyCzas: wykonanie funkcji, wynik dla modelu i dalsza rozmowa", async (t) => {
  const calls = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const first = calls.at(-1).tool_choice?.function?.name === "aktualnyCzas";
    const chunk = {
      id: `time-${calls.length}`, model: "google/test-model", created: 1,
      choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", delta: first ? {
        role: "assistant", content: null,
        tool_calls: [{ index: 0, id: "clock-1", type: "function",
          function: { name: "aktualnyCzas", arguments: "{}" } }],
      } : { role: "assistant", content: "Sprawdziłem aktualny czas w Warszawie." } }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const session = await login(request("/api/auth/login", { password: "test-workshop-password" }));
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const user = { id: "time-user", role: "user", parts: [{ type: "text", text: "Jaki dziś dzień i która godzina?" }] };
  const response = await chat(request("/api/agent", { messages: [user] }, cookie));
  assert.equal(response.status, 200);
  const chunks = (await response.text()).split("\n")
    .filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.some((chunk) => chunk.type === "error"), false);
  assert.equal(calls.length, 2, "model kontynuuje po wyniku funkcji");
  const invocation = chunks.find((chunk) => chunk.type === "tool-input-available");
  assert.equal(invocation?.toolName, "aktualnyCzas");
  assert.equal(invocation.dynamic, undefined, "wywołanie pozostaje typowaną częścią narzędzia");
  const output = chunks.find((chunk) => chunk.type === "tool-output-available")?.output;
  assert.equal(output?.strefa, "Europe/Warsaw");
  assert.match(output.data, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(output.godzina, /^\d{2}:\d{2}:\d{2}$/);
  const toolResult = calls[1].messages.find((message) => message.role === "tool");
  assert.deepEqual(JSON.parse(toolResult.content), output);
  const assistant = { id: "clock-assistant", role: "assistant", parts: [
    { type: "step-start" },
    { type: "tool-aktualnyCzas", toolCallId: "clock-1", state: "output-available", input: {}, output },
    { type: "step-start" },
    { type: "text", text: "Sprawdziłem aktualny czas w Warszawie." },
  ] };
  const followup = { id: "time-next", role: "user", parts: [{ type: "text", text: "A jutro?" }] };
  const next = await chat(request("/api/agent", { messages: [user, assistant, followup] }, cookie));
  assert.equal(next.status, 200);
  await next.text();
  assert.ok(calls[2].messages.some((message) => message.role === "tool"));
});

test("wyszukiwanie: autoryzacja, ustawienia providera, źródła i dalsza rozmowa", async (t) => {
  const calls = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const clockStep = calls.at(-1).tool_choice?.function?.name === "aktualnyCzas";
    const chunk = {
      id: "test-completion", model: "google/test-model", created: 1,
      choices: [{ index: 0, finish_reason: clockStep ? "tool_calls" : "stop", delta: clockStep ? {
        role: "assistant", content: null,
        tool_calls: [{ index: 0, id: "news-clock", type: "function",
          function: { name: "aktualnyCzas", arguments: "{}" } }],
      } : {
        role: "assistant", content: "Odpowiedź oparta na źródle.",
        annotations: [{ type: "url_citation", url_citation: {
          url: "https://example.com/news", title: "Aktualności",
        } }],
      } }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const user = { id: "user-1", role: "user", parts: [{ type: "text", text: "Co nowego ogłosił ostatnio OpenRouter?" }] };
  assert.equal((await chat(request("/api/agent", { messages: [user] }))).status, 401);
  assert.equal(calls.length, 0);

  const session = await login(request("/api/auth/login", { password: "test-workshop-password" }));
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const before = Date.now();
  const response = await chat(request("/api/agent", { messages: [user] }, cookie));
  assert.equal(response.status, 200);
  const stream = await response.text();
  const chunks = stream.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.some((chunk) => chunk.type === "error"), false);
  const source = chunks.find((chunk) => chunk.type === "source-url");
  assert.equal(source?.title, "Aktualności");
  assert.equal(source?.url, "https://example.com/news");
  const metadata = chunks.find((chunk) => chunk.type === "finish")?.messageMetadata;
  assert.ok(Date.parse(metadata?.retrievedAt) >= before);
  assert.equal(calls[0].tools.length, 1);
  assert.equal(calls[0].tools[0].function.name, "aktualnyCzas");
  const clock = chunks.find((chunk) => chunk.type === "tool-output-available")?.output;
  assert.equal(clock.strefa, "Europe/Warsaw");
  const search = calls[1].tools.find((tool) => tool.type === "openrouter:web_search");
  assert.equal(search.max_results, 3);
  assert.equal(search.engine, "native");
  assert.ok(search.search_prompt.includes(clock.data));
  assert.deepEqual(JSON.parse(calls[1].messages.find((message) => message.role === "tool").content), clock);
  const instructions = calls[1].messages.filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content :
      message.content.map((part) => part.text ?? "").join(" ")).join(" ");
  assert.ok(instructions.replace(/\s+/g, " ").includes("Data pobrania strony nie jest datą publikacji"));

  const assistant = {
    id: "assistant-1", role: "assistant", metadata,
    parts: [{ type: "step-start" }, { type: "text", text: "Odpowiedź oparta na źródle." }, source],
  };
  const followup = { ...user, id: "user-2", parts: [{ type: "text", text: "Podaj więcej szczegółów." }] };
  const next = await chat(request("/api/agent", { messages: [user, assistant, followup] }, cookie));
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(calls.length, 3);
  assert.ok(calls[2].messages.some((message) => message.role === "assistant"));
});

const locationFixture = { results: [{
  name: "Warszawa", latitude: 52.23, longitude: 21.01,
  country: "Polska", admin1: "Mazowieckie", population: 1234567,
}] };
const weatherFixture = {
  timezone: "Europe/Warsaw", elevation: 100, generationtime_ms: 0.2,
  current: { time: "2026-11-10T12:00", interval: 900, temperature_2m: 7,
    apparent_temperature: 4, weather_code: 3, wind_speed_10m: 12, precipitation: 0.1 },
};

test("pogoda: czytelne wyniki zamiast wyjątków przy błędach API", async (t) => {
  for (const scenario of ["sieć", "timeout", "HTTP", "brak miejscowości", "niejednoznaczna miejscowość", "błędny JSON", "HTTP prognozy", "niepełna pogoda"]) {
    await t.test(scenario, async (t) => {
      let count = 0;
      t.mock.method(global, "fetch", async (_url, options) => {
        count++;
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.cache, "no-store");
        if (scenario === "sieć") throw new TypeError("fetch failed");
        if (scenario === "timeout") throw new DOMException("timeout", "TimeoutError");
        if (scenario === "HTTP") return new Response("", { status: 503 });
        if (scenario === "błędny JSON") return new Response("not JSON");
        if (scenario === "brak miejscowości") return Response.json({});
        if (scenario === "niejednoznaczna miejscowość") return Response.json({
          results: [...locationFixture.results, { ...locationFixture.results[0], admin1: "Inny region" }],
        });
        if (count === 1) return Response.json(locationFixture);
        if (scenario === "HTTP prognozy") return new Response("", { status: 429 });
        return Response.json({ ...weatherFixture, current: { ...weatherFixture.current, temperature_2m: null } });
      });
      const result = await fetchWeather({ miejscowosc: "Warszawa", kodKraju: "PL" });
      assert.equal(result.ok, false);
      assert.ok(result.komunikat.length > 20);
      assert.ok(Number.isFinite(Date.parse(result.sprawdzonoAt)));
      assert.equal("temperaturaC" in result, false);
      assert.equal(count, ["HTTP prognozy", "niepełna pogoda"].includes(scenario) ? 2 : 1);
    });
  }
});

test("pogoda: model → API → ograniczone pola → model i dalsza rozmowa", async (t) => {
  const calls = [];
  const weatherUrls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "geocoding-api.open-meteo.com") {
      weatherUrls.push(parsed);
      assert.equal(parsed.searchParams.get("name"), "Warszawa");
      assert.equal(parsed.searchParams.get("countryCode"), "PL");
      return Response.json(locationFixture);
    }
    if (parsed.hostname === "api.open-meteo.com") {
      weatherUrls.push(parsed);
      assert.equal(parsed.pathname, "/v1/forecast");
      assert.equal(parsed.searchParams.get("latitude"), "52.23");
      assert.equal(parsed.searchParams.get("longitude"), "21.01");
      assert.equal(parsed.searchParams.get("temperature_unit"), "celsius");
      assert.equal(parsed.searchParams.get("wind_speed_unit"), "kmh");
      assert.equal(parsed.searchParams.get("timezone"), "auto");
      assert.equal(parsed.searchParams.get("current"), "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation");
      return Response.json(weatherFixture);
    }
    assert.equal(parsed.hostname, "openrouter.ai", "żaden test nie wykonuje prawdziwych połączeń");
    calls.push(JSON.parse(options.body));
    const first = calls.length === 1;
    const chunk = {
      id: `weather-${calls.length}`, model: "google/test-model", created: 1,
      choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", delta: first ? {
        role: "assistant", content: null,
        tool_calls: [{ index: 0, id: "weather-call", type: "function",
          function: { name: "pogoda", arguments: JSON.stringify({ miejscowosc: "Warszawa", kodKraju: "PL" }) } }],
      } : { role: "assistant", content: "W Warszawie jest 7°C, pochmurno. Źródło: Open-Meteo." } }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const user = { id: "weather-user", role: "user", parts: [{ type: "text", text: "Jaka pogoda w Warszawie?" }] };
  assert.equal((await chat(request("/api/agent", { messages: [user] }))).status, 401);
  assert.equal(calls.length + weatherUrls.length, 0);
  const session = await login(request("/api/auth/login", { password: "test-workshop-password" }));
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const before = Date.now();
  const response = await chat(request("/api/agent", { messages: [user] }, cookie));
  const chunks = (await response.text()).split("\n").filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.some((chunk) => chunk.type === "error"), false);
  assert.equal(chunks.find((chunk) => chunk.type === "tool-input-available")?.toolName, "pogoda");
  const output = chunks.find((chunk) => chunk.type === "tool-output-available")?.output;
  assert.equal(output.ok, true);
  assert.equal(output.temperaturaC, 7);
  assert.equal(output.opis, "pochmurno");
  assert.equal(output.okresOpadowMin, 15);
  assert.ok(Date.parse(output.pobranoAt) >= before);
  assert.equal("generationtime_ms" in output, false);
  assert.equal("population" in output, false);
  assert.deepEqual(JSON.parse(calls[1].messages.find((message) => message.role === "tool").content), output);
  const assistant = { id: "weather-assistant", role: "assistant", parts: [
    { type: "step-start" },
    { type: "tool-pogoda", toolCallId: "weather-call", state: "output-available",
      input: { miejscowosc: "Warszawa", kodKraju: "PL" }, output },
    { type: "step-start" }, { type: "text", text: "W Warszawie jest 7°C." },
  ] };
  const next = await chat(request("/api/agent", { messages: [user, assistant,
    { id: "weather-next", role: "user", parts: [{ type: "text", text: "A wiatr?" }] }] }, cookie));
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(calls.length, 3);
  assert.equal(weatherUrls.length, 2);
  assert.ok(calls[2].messages.some((message) => message.role === "tool"));
});
