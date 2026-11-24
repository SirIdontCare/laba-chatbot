const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
Object.assign(process.env, { NODE_ENV: 'development', VERCEL: '', VERCEL_PROJECT_PRODUCTION_URL: '',
  SESSION_SECRET: 'tools-offline-session-secret-32-characters',
  NEXT_PUBLIC_SUPABASE_URL: 'https://tools-test.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_tools_test',
  OPENROUTER_API_KEY: 'fake-secret-never-return', OPENROUTER_MODEL: 'test/tools-model' });
const { installFakeAuth, TEST_AUTH_COOKIE } = require('./fake-auth.cjs');
installFakeAuth();
const { fetchCurrency, currencyInputSchema } = require('../lib/currency-tool.ts');
const { fetchHolidays, holidaysInputSchema } = require('../lib/holidays-tool.ts');
const { fetchWikipedia, wikipediaInputSchema } = require('../lib/wikipedia-tool.ts');
const { fetchWeather } = require('../lib/weather-tool.ts');
const { calculate, calculatorInputSchema, createNotesTool, createDiagnosticsTool } = require('../lib/local-tools.ts');
const { czas, warsawTime } = require('../lib/chat-tools.ts');
const { createAgentTools } = require('../lib/agent-tools.ts');
const { TOOL_LABELS, AGENT_STEP_LIMIT } = require('../lib/tool-catalog.ts');
const { POST: chat } = require('../app/api/agent/route.ts');
const options = { toolCallId: 'test', messages: [] };
const request = (body, cookie = '') => new Request('http://localhost:3000/api/agent', {
  method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', cookie },
  body: JSON.stringify({ mode: 'chat', ...body }),
});
const assertTimestamp = (out) => assert.ok(Number.isFinite(Date.parse(out.pobranoAt ?? out.sprawdzonoAt)));
const location = { results: [{ name: 'Warszawa', latitude: 52.23, longitude: 21.01, country: 'Polska', admin1: 'Mazowieckie' }] };
const rate = { table: 'A', code: 'EUR', currency: 'euro', rates: [{ no: 'test', effectiveDate: '2026-11-10', mid: 4.25 }], secretExtra: 'discard' };
const date = warsawTime().data;
const forecast = { timezone: 'Europe/Warsaw', elevation: 100, daily: { time: [date], temperature_2m_min: [4], temperature_2m_max: [9],
  precipitation_sum: [2], precipitation_probability_max: [70], wind_speed_10m_max: [22], weather_code: [61] } };
const holiday = { date: '2026-01-01', localName: 'Nowy Rok', name: "New Year's Day", countryCode: 'PL',
  global: true, counties: null, types: ['Public'], fixed: true, launchYear: 1900 };
const article = { query: { pages: [{ pageid: 123, title: 'Warszawa', extract: 'Warszawa to stolica Polski.' }] } };

// Każdy fetch jest atrapą, testy nie korzystają z .env ani płatnych modeli.
test('schematy odrzucają kod, nieliczby, błędne kody, daty i dodatkowe pola', () => {
  for (const input of [{ dzialanie: 'eval', a: 1, b: 2 }, { dzialanie: 'dodaj', a: '1', b: 2 },
    { dzialanie: 'dodaj', a: Infinity, b: 2 }, { dzialanie: 'dodaj', a: 1, b: 2, kod: 'process.exit()' }]) {
    assert.equal(calculatorInputSchema.safeParse(input).success, false);
  }
  for (const input of [{ waluta: '../../x' }, { waluta: 'EUR', kwota: -1 }, { waluta: 'EUR', kwota: '3' }]) {
    assert.equal(currencyInputSchema.safeParse(input).success, false);
  }
  assert.equal(holidaysInputSchema.safeParse({ kodKraju: 'Polska', rok: 2026 }).success, false);
  assert.equal(holidaysInputSchema.safeParse({ kodKraju: 'PL', rok: 2026.5 }).success, false);
  assert.equal(wikipediaInputSchema.safeParse({ haslo: 'A|B' }).success, false);
});

test('kalkulator: wszystkie działania, zero, przepełnienie i wynik nierzeczywisty', () => {
  for (const [dzialanie, a, b, expected] of [['dodaj', 2, 3, 5], ['odejmij', 2, 3, -1], ['pomnoz', 2, 3, 6],
    ['podziel', 9, 3, 3], ['potega', 2, 3, 8], ['procent', 20, 150, 30]]) {
    const out = calculate({ dzialanie, a, b });
    assert.equal(out.ok, true); assert.equal(out.wynik, expected); assertTimestamp(out);
  }
  for (const input of [{ dzialanie: 'podziel', a: 1, b: 0 }, { dzialanie: 'potega', a: -1, b: .5 },
    { dzialanie: 'potega', a: 1e308, b: 10 }, { dzialanie: 'dodaj', a: 'process.exit()', b: 1 }]) {
    const out = calculate(input); assert.equal(out.ok, false); assertTimestamp(out);
  }
});

test('czas: domyślna strefa, Tokio, zmiana czasu i nieznana strefa', async () => {
  const defaultTime = await czas.execute({}, options); assert.equal(defaultTime.strefa, 'Europe/Warsaw'); assertTimestamp(defaultTime);
  const tokyo = await czas.execute({ strefa: 'Asia/Tokyo' }, options); assert.equal(tokyo.strefa, 'Asia/Tokyo'); assertTimestamp(tokyo);
  assert.equal(warsawTime(new Date('2026-11-12T23:00:00Z'), 'Asia/Tokyo').data, '2026-11-13');
  assert.equal(warsawTime(new Date('2026-03-29T01:00:00Z')).godzina, '03:00:00');
  const invalid = await czas.execute({ strefa: 'Mars/Olympus' }, options);
  assert.equal(invalid.ok, false); assert.match(invalid.komunikat, /stref/); assertTimestamp(invalid);
});

test('waluty: kurs, oba kierunki, tabela B, data publikacji i redukcja pól', async (t) => {
  const urls = [];
  t.mock.method(global, 'fetch', async (url, opts) => { urls.push(String(url)); assert.equal(opts.cache, 'no-store');
    assert.ok(opts.signal instanceof AbortSignal); return Response.json(rate); });
  const to = await fetchCurrency({ waluta: 'eur', kwota: 10 });
  assert.equal(to.ok, true); assert.equal(to.wynik, 42.5); assert.equal(to.walutaWyniku, 'PLN');
  assert.equal(to.dataKursu, '2026-11-10'); assert.equal(to.kursPLN, 4.25); assert.equal('secretExtra' in to, false); assertTimestamp(to);
  const from = await fetchCurrency({ waluta: 'EUR', kwota: 42.5, kierunek: 'zPLN' });
  assert.equal(from.wynik, 10); assert.equal(from.walutaWyniku, 'EUR');
  const onlyRate = await fetchCurrency({ waluta: 'EUR' }); assert.equal('wynik' in onlyRate, false);
  assert.ok(urls[0].includes('/rates/a/EUR/'));
  t.mock.method(global, 'fetch', async (url) => String(url).includes('/a/') ? new Response('', { status: 404 }) :
    Response.json({ ...rate, code: 'ALL', currency: 'lek' }));
  const tableB = await fetchCurrency({ waluta: 'ALL' }); assert.equal(tableB.ok, true); assert.ok(tableB.zrodlo.includes('/b/ALL/'));
});

test('święta: kraj, rok, regiony, wyłącznie Public i redukcja pól', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    assert.equal(String(url), 'https://date.nager.at/api/v3/PublicHolidays/2026/PL');
    return Response.json([holiday, { ...holiday, localName: 'Regionalne', global: false, counties: ['PL-MZ'] },
      { ...holiday, localName: 'Obserwacja', types: ['Observance'] }]);
  });
  const out = await fetchHolidays({ kodKraju: 'pl', rok: 2026 });
  assert.equal(out.ok, true); assert.equal(out.swieta.length, 2); assert.equal(out.swieta[1].calyKraj, false);
  assert.deepEqual(out.swieta[1].regiony, ['PL-MZ']); assert.equal('launchYear' in out.swieta[0], false); assertTimestamp(out);
});

test('wikipedia: tekst bez HTML, polski adres, przekierowania i niejednoznaczność', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const u = new URL(url); assert.equal(u.hostname, 'pl.wikipedia.org'); assert.equal(u.searchParams.get('explaintext'), '1');
    assert.equal(u.searchParams.get('redirects'), '1'); assert.equal(u.searchParams.get('formatversion'), '2');
    return Response.json({ query: { pages: [{ ...article.query.pages[0], title: 'Łódź', pageprops: {} }] } });
  });
  const out = await fetchWikipedia({ haslo: 'Łódź' });
  assert.equal(out.ok, true); assert.equal(out.streszczenie, article.query.pages[0].extract);
  assert.equal(out.url, 'https://pl.wikipedia.org/wiki/%C5%81%C3%B3d%C5%BA'); assert.equal('pageid' in out, false); assertTimestamp(out);
  t.mock.method(global, 'fetch', async () => Response.json({ query: { pages: [{ title: 'Łódź', pageprops: { disambiguation: '' } }] } }));
  assert.equal((await fetchWikipedia({ haslo: 'Łódź' })).ok, false);
});

test('prognoza: wybrany dzień, jednostki, dane dzienne i redukcja pól', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname.startsWith('geocoding')) return Response.json(location);
    assert.equal(u.searchParams.get('start_date'), date); assert.equal(u.searchParams.get('end_date'), date);
    assert.equal(u.searchParams.get('timezone'), 'auto'); assert.equal(u.searchParams.get('temperature_unit'), 'celsius');
    assert.ok(u.searchParams.get('daily').includes('precipitation_sum')); assert.equal(u.searchParams.has('current'), false);
    return Response.json(forecast);
  });
  const out = await fetchWeather({ miejscowosc: 'Warszawa', kodKraju: 'PL', dzien: date });
  assert.equal(out.ok, true); assert.equal(out.rodzaj, 'prognoza'); assert.equal(out.dzien, date);
  assert.equal(out.temperaturaMinC, 4); assert.equal(out.temperaturaMaxC, 9); assert.equal(out.opadyMm, 2);
  assert.equal(out.wiatrMaxKmh, 22); assert.equal('elevation' in out, false); assertTimestamp(out);
});

test('prognoza: daty poza zasięgiem, nieprawidłowe i niezgodne dane', async (t) => {
  for (const scenario of ['historyczna', 'odległa', 'niepełna', 'inna data', '400', 'HTTP', 'sieć']) {
    await t.test(scenario, async (t) => {
      t.mock.method(global, 'fetch', async (url) => {
        if (new URL(url).hostname.startsWith('geocoding')) return Response.json(location);
        if (scenario === '400') return new Response('', { status: 400 });
        if (scenario === 'HTTP') return new Response('', { status: 503 });
        if (scenario === 'sieć') throw new TypeError('network');
        const day = scenario === 'historyczna' ? '2000-01-01' : scenario === 'odległa' ? '2099-01-01' : scenario === 'inna data' ? '2020-01-01' : date;
        return Response.json({ ...forecast, daily: { ...forecast.daily, time: [day],
          temperature_2m_min: scenario === 'niepełna' ? [null] : [4] } });
      });
      const day = scenario === 'historyczna' ? '2000-01-01' : scenario === 'odległa' ? '2099-01-01' : date;
      const out = await fetchWeather({ miejscowosc: 'Warszawa', dzien: day });
      assert.equal(out.ok, false); assertTimestamp(out); assert.ok(out.komunikat.length > 20);
    });
  }
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw new Error('Nie powinno wystąpić'); });
  assert.equal((await fetchWeather({ miejscowosc: 'Warszawa', dzien: '2026-02-30' })).ok, false);
  assert.equal(calls, 0);
});

test('zewnętrzne API: brak danych, timeout, HTTP, zły JSON i niepełne dane to polskie komunikaty', async (t) => {
  for (const [name, run, missing] of [
    ['NBP', () => fetchCurrency({ waluta: 'ZZZ' }), () => new Response('', { status: 404 })],
    ['Nager', () => fetchHolidays({ kodKraju: 'ZZ', rok: 2026 }), () => new Response('', { status: 404 })],
    ['Wiki', () => fetchWikipedia({ haslo: 'Nieistniejące' }), () => Response.json({ query: { pages: [{ title: 'Nieistniejące', missing: true }] } })],
  ]) {
    for (const scenario of ['brak', 'timeout', 'HTTP', 'JSON', 'niepełne']) {
      await t.test(`${name} ${scenario}`, async (t) => {
        t.mock.method(global, 'fetch', async (_url, opts) => {
          assert.ok(opts.signal instanceof AbortSignal); assert.equal(opts.cache, 'no-store');
          if (scenario === 'brak') return missing();
          if (scenario === 'timeout') throw new DOMException('timeout', 'TimeoutError');
          if (scenario === 'HTTP') return new Response('', { status: 503 });
          if (scenario === 'JSON') return new Response('not json');
          return Response.json({});
        });
        const out = await run(); assert.equal(out.ok, false); assert.ok(out.komunikat.length > 20); assertTimestamp(out);
      });
    }
  }
});

test('notatki: zapis i odczyt między żądaniami, izolacja sesji, walidacja i limit', async () => {
  const scope = crypto.randomUUID();
  const first = createNotesTool(scope);
  const saved = await first.execute({ akcja: 'zapisz', tresc: 'Plan lekcji' }, options);
  assert.equal(saved.ok, true); assertTimestamp(saved); assert.equal(saved.notatki[0].tresc, 'Plan lekcji');
  const read = await createNotesTool(scope).execute({ akcja: 'pokaz' }, options);
  assert.deepEqual(read.notatki, saved.notatki);
  read.notatki[0].tresc = 'zmiana kopii';
  assert.equal((await first.execute({ akcja: 'pokaz' }, options)).notatki[0].tresc, 'Plan lekcji');
  assert.deepEqual((await createNotesTool(crypto.randomUUID()).execute({ akcja: 'pokaz' }, options)).notatki, []);
  assert.equal((await first.execute({ akcja: 'zapisz', tresc: ' ' }, options)).ok, false);
  assert.equal((await first.execute({ akcja: 'zapisz', tresc: 'x'.repeat(2001) }, options)).ok, false);
  for (let i = 1; i < 100; i++) await first.execute({ akcja: 'zapisz', tresc: `Notatka ${i}` }, options);
  assert.equal((await first.execute({ akcja: 'zapisz', tresc: 'Nadmiarowa' }, options)).ok, false);
  assert.equal((await first.execute({ akcja: 'pokaz' }, options)).notatki.length, 100);
});

test('diagnostyka: zgodność z rejestrem, etykiety, limit i brak wartości sekretów', async () => {
  const tools = createAgentTools('diagnostic-test');
  const out = await tools.diagnostyka.execute({}, options);
  assert.deepEqual(out.narzedzia.sort(), [...Object.keys(tools), 'web_search'].sort());
  assert.deepEqual(out.narzedzia.sort(), Object.keys(TOOL_LABELS).sort());
  assert.equal(out.limitKrokow, AGENT_STEP_LIMIT); assert.equal(out.model, 'test/tools-model'); assertTimestamp(out);
  for (const value of Object.values(out.zmienne)) assert.equal(value, 'tak');
  const json = JSON.stringify(out);
  for (const key of ['OPENROUTER_API_KEY', 'SESSION_SECRET']) assert.equal(json.includes(process.env[key]), false);
  const before = process.env.OPENROUTER_API_KEY;
  try { delete process.env.OPENROUTER_API_KEY;
    assert.equal((await createDiagnosticsTool([], 12).execute({}, options)).zmienne.OPENROUTER_API_KEY, 'nie');
  } finally { process.env.OPENROUTER_API_KEY = before; }
});

function sse(delta, finish) {
  return new Response(`data: ${JSON.stringify({ id: 'tools', model: 'test/tools-model', created: 1,
    choices: [{ index: 0, finish_reason: finish, delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('nowe narzędzia: model → funkcja/API → UI → kolejna tura, bez prawdziwej sieci', async (t) => {
  for (const [name, input] of [ ['pogoda', { miejscowosc: 'Warszawa', dzien: date }], ['waluty', { waluta: 'EUR', kwota: 10 }],
    ['swieta', { kodKraju: 'PL', rok: 2026 }], ['wikipedia', { haslo: 'Warszawa' }],
    ['kalkulator', { dzialanie: 'dodaj', a: 2, b: 3 }], ['czas', { strefa: 'Asia/Tokyo' }],
    ['notatki', { akcja: 'zapisz', tresc: 'Notatka z czatu' }], ['diagnostyka', {}] ]) {
    await t.test(name, async (t) => {
      const calls = [];
      t.mock.method(global, 'fetch', async (url, opts) => {
        const host = new URL(url).hostname;
        if (host === 'geocoding-api.open-meteo.com') return Response.json(location);
        if (host === 'api.open-meteo.com') return Response.json(forecast);
        if (host === 'api.nbp.pl') return Response.json(rate);
        if (host === 'date.nager.at') return Response.json([holiday]);
        if (host === 'pl.wikipedia.org') return Response.json(article);
        assert.equal(host, 'openrouter.ai', 'nieoczekiwane połączenie');
        const body = JSON.parse(opts.body); calls.push(body);
        assert.equal(body.tools.length, Object.keys(TOOL_LABELS).length);
        if (name === 'notatki') {
          const schema = body.tools.find((entry) => entry.function?.name === 'notatki').function.parameters;
          assert.equal(schema.type, 'object', 'model musi dostać pojedynczy obiekt zamiast unii z dyskryminatorem');
          assert.deepEqual(schema.properties.akcja.enum, ['zapisz', 'pokaz']);
          assert.ok(schema.required.includes('akcja'));
          assert.equal(schema.oneOf, undefined);
          assert.equal(schema.anyOf, undefined);
        }
        if (calls.length === 1) return sse({ role: 'assistant', content: null,
          tool_calls: [{ index: 0, id: `${name}-call`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls');
        return sse({ role: 'assistant', content: 'Gotowe.' }, 'stop');
      });
      const cookie = TEST_AUTH_COOKIE;
      const user = { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Wykonaj zadanie.' }] };
      const response = await chat(request({ messages: [user] }, cookie)); assert.equal(response.status, 200);
      const chunks = (await response.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
      assert.equal(chunks.some((c) => c.type === 'error' || c.type === 'tool-output-error'), false);
      assert.equal(chunks.find((c) => c.type === 'tool-input-available').toolName, name);
      const output = chunks.find((c) => c.type === 'tool-output-available').output;
      assert.notEqual(output.ok, false); assertTimestamp(output);
      assert.deepEqual(JSON.parse(calls[1].messages.find((m) => m.role === 'tool').content), output);
      const assistant = { id: 'assistant', role: 'assistant', parts: [
        { type: `tool-${name}`, toolCallId: `${name}-call`, state: 'output-available', input, output }, { type: 'text', text: 'Gotowe.' }] };
      const followup = await chat(request({ messages: [user, assistant, { ...user, id: 'next' }] }, cookie));
      assert.equal(followup.status, 200); await followup.text();
      assert.equal(calls.length, 3); assert.ok(calls[2].messages.some((m) => m.role === 'tool'));
    });
  }
});

test('notatki: zapis i pokazanie notatki o lotach przez prawdziwy endpoint i SDK', async (t) => {
  const outputs = [];
  let modelCalls = 0;
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(new URL(url).hostname, 'openrouter.ai');
    const body = JSON.parse(opts.body);
    const previous = body.messages.filter((message) => message.role === 'tool');
    modelCalls++;
    if (previous.length === 0) return sse({ role: 'assistant', content: null,
      tool_calls: [{ index: 0, id: 'save-note', type: 'function', function: { name: 'notatki',
        arguments: JSON.stringify({ akcja: 'zapisz', tresc: 'sprawdzić ceny lotów do Lizbony' }) } }] }, 'tool_calls');
    const output = JSON.parse(previous.at(-1).content); outputs.push(output);
    assert.equal(output.ok, true);
    if (previous.length === 1 && body.messages.at(-2)?.tool_calls?.[0]?.id === 'save-note') {
      return sse({ role: 'assistant', content: null,
        tool_calls: [{ index: 0, id: 'read-notes', type: 'function', function: { name: 'notatki',
          arguments: JSON.stringify({ akcja: 'pokaz', tresc: null }) } }] }, 'tool_calls');
    }
    return sse({ role: 'assistant', content: 'Zapisano. Notatki: sprawdzić ceny lotów do Lizbony.' }, 'stop');
  });
  const cookie = TEST_AUTH_COOKIE;
  const user = { id: 'note-request', role: 'user', parts: [{ type: 'text', text: 'Zapisz notatkę: sprawdzić ceny lotów do Lizbony. Potem pokaż wszystkie notatki.' }] };
  const response = await chat(request({ messages: [user] }, cookie));
  const chunks = (await response.text()).split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.some((chunk) => chunk.type === 'error' || chunk.type === 'tool-output-error'), false);
  const toolOutputs = chunks.filter((chunk) => chunk.type === 'tool-output-available');
  assert.equal(toolOutputs.length, 2); assert.equal(modelCalls, 3);
  assert.equal(toolOutputs[1].output.notatki[0].tresc, 'sprawdzić ceny lotów do Lizbony');
  assert.equal(toolOutputs[1].output.notatki[0].id, toolOutputs[0].output.notatki[0].id);
  // Osobne żądanie w tej samej sesji: odczyt ma pochodzić z pamięci serwera, nie tekstu historii.
  t.mock.method(global, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const result = body.messages.find((message) => message.role === 'tool');
    if (result) {
      assert.equal(JSON.parse(result.content).notatki[0].tresc, 'sprawdzić ceny lotów do Lizbony');
      return sse({ role: 'assistant', content: 'sprawdzić ceny lotów do Lizbony' }, 'stop');
    }
    return sse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'read-again', type: 'function',
      function: { name: 'notatki', arguments: JSON.stringify({ akcja: 'pokaz' }) } }] }, 'tool_calls');
  });
  const next = await chat(request({ messages: [{ id: 'read-next', role: 'user', parts: [{ type: 'text', text: 'Pokaż notatki.' }] }] }, cookie));
  assert.equal(next.status, 200); assert.equal((await next.text()).includes('tool-output-error'), false);
});

test('ReAct: limit narzędzi zatrzymuje zadanie przed limitem 18 kroków', async (t) => {
  let count = 0;
  t.mock.method(global, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body); count++;
    assert.equal(body.parallel_tool_calls, false);
    if (count > 1) {
      const previous = body.messages.filter((m) => m.role === 'tool');
      assert.equal(previous.length, count - 1);
      assert.equal(JSON.parse(previous.at(-1).content).wynik, count);
    }
    return sse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `calc-${count}`, type: 'function',
      function: { name: 'kalkulator', arguments: JSON.stringify({ dzialanie: 'dodaj', a: count, b: 1 }) } }] }, 'tool_calls');
  });
  const cookie = TEST_AUTH_COOKIE;
  const response = await chat(request({ messages: [{ id: 'loop', role: 'user', parts: [{ type: 'text', text: 'Wykonaj serię obliczeń.' }] }] }, cookie));
  const chunks = (await response.text()).split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
  assert.equal(count, 16);
  assert.equal(chunks.some((c) => c.type === 'error'), false);
  const metadata = chunks.findLast((c) => c.messageMetadata?.stoppedReason)?.messageMetadata;
  assert.ok(metadata, 'UI musi otrzymać informację o limicie nawet bez tekstu modelu');
  assert.deepEqual(metadata.steps, Array.from({ length: 16 }, (_, i) => ({ number: i + 1, tool: 'kalkulator' })));
  assert.equal(metadata.partialResults.length, 16);
  assert.equal(JSON.parse(metadata.partialResults[15].text).wynik, 17);
  assert.equal(AGENT_STEP_LIMIT, 18);
});

test('Stop zachowuje częściowy tekst i wyniki oraz działa przed pierwszą odpowiedzią', () => {
  const { markInterrupted } = require('../lib/chat-message.ts');
  const user = { id: 'u-stop', role: 'user', parts: [{ type: 'text', text: 'Zadanie' }] };
  const assistant = { id: 'a-stop', role: 'assistant', metadata: { steps: [{ number: 1, tool: 'kalkulator' }] },
    parts: [{ type: 'text', text: 'Częściowa odpowiedź' }, { type: 'tool-kalkulator', toolCallId: 'calc-stop', state: 'output-available',
      input: { dzialanie: 'dodaj', a: 1, b: 2 }, output: { ok: true, wynik: 3, pobranoAt: new Date().toISOString() } }] };
  const result = markInterrupted([user, assistant]);
  assert.deepEqual(result[1].parts.slice(0, 2), assistant.parts);
  assert.deepEqual(result[1].metadata, assistant.metadata);
  assert.equal(result[1].parts.at(-1).text.trim(), 'Przerwane przez użytkownika');
  assert.equal(assistant.parts.length, 2);
  const early = markInterrupted([user]);
  assert.equal(early[1].role, 'assistant');
  assert.equal(early[1].parts[0].text.trim(), 'Przerwane przez użytkownika');
});

test('dashboard: ochrona sesją i origin oraz pięć kart z częściowym błędem', async (t) => {
  const { POST: dashboard } = require('../app/api/dashboard/route.ts');
  let calls = 0;
  const req = (cookie = '', origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/dashboard', {
    method: 'POST', headers: { origin, cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Warszawa', date }) });
  t.mock.method(global, 'fetch', async (url) => {
    calls++;
    const u = new URL(url);
    if (u.hostname.startsWith('geocoding')) return Response.json({ results: [{ ...location.results[0], country_code: 'PL', timezone: 'Europe/Warsaw' }] });
    if (u.hostname === 'api.open-meteo.com') return Response.json(forecast);
    if (u.hostname === 'date.nager.at') return Response.json([ { ...holiday, date: `${u.pathname.split('/')[4]}-12-25` } ]);
    if (u.hostname === 'pl.wikipedia.org') return new Response('', { status: 503 });
    throw new Error('Nieoczekiwany host');
  });
  assert.equal((await dashboard(req())).status, 401); assert.equal(calls, 0);
  const cookie = TEST_AUTH_COOKIE;
  assert.equal((await dashboard(req(cookie, 'https://obca.example'))).status, 403); assert.equal(calls, 0);
  const key = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = '';
    const response = await dashboard(req(cookie)); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.cards.length, 5);
    assert.equal(body.cards.find((c) => c.title === 'Wikipedia').error, true);
    assert.equal(body.cards.find((c) => c.title === 'Wikipedia').value, 'Brak danych — spróbuj odświeżyć');
    assert.match(body.summary, /Brak danych ze źródeł: Polska Wikipedia/);
    assert.equal(body.cards.filter((c) => !c.error).length, 4);
    assert.match(body.cards.find((c) => c.title === 'Waluty').value, /1 PLN = 1 PLN/);
    assert.match(body.cards.find((c) => c.title === 'Czas').value, /0 h/);
    for (const card of body.cards) assert.ok(Number.isFinite(Date.parse(card.fetchedAt)));
    assert.match(body.summary, /niedostępne/);
  } finally { process.env.OPENROUTER_API_KEY = key; }
});

test('miasta: Berlin, doprecyzowanie kraju, pusty wynik i niepoprawna odpowiedź źródła', async (t) => {
  const { searchCities, CityLookupError } = require('../lib/city-search.ts');
  const berlin = { name: 'Berlin', latitude: 52.52, longitude: 13.41, country: 'Niemcy', country_code: 'DE', timezone: 'Europe/Berlin', feature_code: 'PPLC' };
  t.mock.method(global, 'fetch', async (url) => {
    const u = new URL(url); assert.equal(u.searchParams.get('name'), 'Berlin');
    return Response.json({ results: [berlin, { ...berlin, country: 'USA', country_code: 'US', feature_code: 'PPL' }] });
  });
  assert.equal((await searchCities('Berlin'))[0].country_code, 'DE');
  assert.equal((await searchCities('Berlin, Niemcy')).length, 1);
  const languages = [];
  t.mock.method(global, 'fetch', async (url) => { const lang = new URL(url).searchParams.get('language'); languages.push(lang);
    return Response.json(lang === 'pl' ? { generationtime_ms: 0.5 } : { results: [berlin] }); });
  assert.equal((await searchCities('Berlin'))[0].name, 'Berlin'); assert.deepEqual(languages, ['pl', 'en']);
  t.mock.method(global, 'fetch', async () => Response.json({ error: true, reason: 'upstream failed' }));
  await assert.rejects(searchCities('Berlin'), CityLookupError);
  t.mock.method(global, 'fetch', async () => Response.json({ generationtime_ms: 0.5 }));
  assert.deepEqual(await searchCities('Nieistniejące miasto'), []);
});

test('porównanie: wspólna data, oba miasta, jedno podsumowanie i awaria jednego miasta', async (t) => {
  const { compareDestinations } = require('../lib/travel-dashboard.ts');
  let modelCalls = 0;
  let failBerlin = false;
  const forecastDates = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    const u = new URL(url);
    if (u.hostname.startsWith('geocoding')) {
      const berlin = u.searchParams.get('name') === 'Berlin';
      if (berlin && failBerlin) return Response.json({ generationtime_ms: 0.5 });
      return Response.json({ results: [{ ...location.results[0], name: berlin ? 'Berlin' : 'Warszawa', country_code: berlin ? 'DE' : 'PL', timezone: 'Europe/Warsaw' }] });
    }
    if (u.hostname === 'api.open-meteo.com') { forecastDates.push(u.searchParams.get('start_date')); return Response.json(forecast); }
    if (u.hostname === 'api.nbp.pl') return Response.json(rate);
    if (u.hostname === 'date.nager.at') return Response.json([{ ...holiday, countryCode: u.pathname.split('/').at(-1), date: `${u.pathname.split('/')[4]}-12-25` }]);
    if (u.hostname === 'pl.wikipedia.org') return Response.json(article);
    assert.equal(u.hostname, 'openrouter.ai'); modelCalls++;
    const body = JSON.parse(opts.body);
    assert.ok(JSON.stringify(body.messages).includes('Berlin'));
    assert.ok(JSON.stringify(body.messages).includes('Warszawa'));
    return Response.json({ id: 'compare', model: 'test/tools-model', created: 1, choices: [{ index: 0,
      message: { role: 'assistant', content: 'Polecam Warszawę: prognoza przewiduje 4–9 °C. Spakuj kurtkę.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const first = await compareDestinations('Warszawa', 'Berlin', date, new AbortController().signal);
  assert.equal(first.cities.length, 2); assert.equal(modelCalls, 1);
  assert.match(first.summary, /Polecam Warszawę/);
  assert.ok(first.cities.every((city) => city.date === date && city.cards.length === 5));
  assert.ok(forecastDates.every((value) => value === date));
  failBerlin = true;
  const second = await compareDestinations('Warszawa', 'Berlin', date, new AbortController().signal);
  assert.ok(second.cities[0].cards.every((card) => !card.error));
  assert.ok(second.cities[1].cards.every((card) => card.error));
  assert.match(second.summary, /Brak danych: Berlin/);
});

test('dashboard: prognoza używa ustalonych współrzędnych bez ponownego wyszukiwania miasta', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    assert.equal(new URL(url).hostname, 'api.open-meteo.com', 'nie wolno ponownie geokodować ustalonego miasta');
    return Response.json(forecast);
  });
  const out = await fetchWeather({ miejscowosc: 'Torrevieja', dzien: date }, undefined,
    { name: 'Torrevieja', latitude: 37.98, longitude: -.68, country_code: 'ES', timezone: 'Europe/Madrid' });
  assert.equal(out.ok, true);
});
