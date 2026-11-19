const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
// Wszystkie adresy i klucze są fałszywe; każdy fetch jest atrapą, nic nie trafia do OpenRouter ani Supabase.
Object.assign(process.env, { NODE_ENV: 'development', VERCEL: '', VERCEL_PROJECT_PRODUCTION_URL: '',
  CHAT_PASSWORD: 'kb-test-password', SESSION_SECRET: 'kb-offline-session-secret-32-characters!',
  OPENROUTER_API_KEY: 'fake-openrouter-key', OPENROUTER_EMBEDDING_MODEL: 'test/embedding-model',
  SUPABASE_URL: 'http://supabase.test', SUPABASE_SECRET_KEY: 'fake-supabase-key' });
const { saveDocument, listDocuments, KB_MESSAGES, BACKFILL_LIMIT } = require('../lib/knowledge-base.ts');
const { readUploadEvents, STAGE_LABELS } = require('../lib/upload-stream.ts');
const { EMBEDDING_DIMENSIONS } = require('../lib/model.ts');
const { POST: upload, DELETE: remove } = require('../app/api/upload/route.ts');
const { authConfig, createSession } = require('../lib/session.ts');

const vector = (seed) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (seed + i) / 10_000);

// Minimalna atrapa PostgREST (tabele documents i chunks) i endpointu embeddingów OpenRouter.
// log zapisuje kolejność wywołań sieci, żeby sprawdzić, że etapy idą za prawdziwą pracą serwera.
let db, embedCalls, embedResponse, log;
beforeEach(() => {
  db = { documents: [], chunks: [], nextId: { documents: 1, chunks: 100 } };
  embedCalls = [];
  log = [];
  embedResponse = (input) => Response.json({ object: 'list', model: 'test/embedding-model',
    data: input.map((_, index) => ({ object: 'embedding', index, embedding: vector(index) })) });
});

function filters(url) {
  const out = [];
  for (const [key, value] of url.searchParams) {
    if (['select', 'order', 'limit', 'on_conflict', 'columns'].includes(key)) continue;
    const [op, ...rest] = value.split('.');
    const raw = rest.join('.');
    out.push(row => op === 'eq' ? String(row[key]) === raw : op === 'is' && raw === 'null' ? row[key] == null : true);
  }
  return row => out.every(match => match(row));
}

function withCounts(table, url, rows) {
  if (table !== 'documents' || !url.searchParams.get('select')?.includes('chunks(count)')) return rows;
  return rows.map(row => ({ ...row, chunks: [{ count: db.chunks.filter(chunk => chunk.document_id === row.id).length }] }));
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.hostname === 'openrouter.ai') {
    assert.equal(url.pathname, '/api/v1/embeddings');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'test/embedding-model');
    embedCalls.push(body.input);
    log.push('embeddings');
    return embedResponse(body.input);
  }
  assert.equal(url.hostname, 'supabase.test', `nieoczekiwany adres ${url}`);
  const table = url.pathname.replace('/rest/v1/', '');
  log.push(`${method} ${table}`);
  const rows = db[table];
  const match = filters(url);
  const headers = new Headers(init.headers);
  const single = headers.get('accept') === 'application/vnd.pgrst.object+json';
  const reply = (data, status = 200) => headers.get('prefer')?.includes('return=minimal')
    ? new Response(null, { status: 204 })
    : Response.json(single ? data[0] : withCounts(table, url, data), { status });
  if (method === 'GET') {
    let found = rows.filter(match).sort((a, b) => url.searchParams.get('order') === 'created_at.desc'
      ? b.created_at.localeCompare(a.created_at) : a.id - b.id);
    if (url.searchParams.has('limit')) found = found.slice(0, Number(url.searchParams.get('limit')));
    return reply(found);
  }
  if (method === 'POST') {
    const body = [JSON.parse(init.body)].flat();
    if (table === 'chunks' && db.failChunkInsert) return Response.json({ message: 'insert failed' }, { status: 500 });
    const created = body.map(row => ({ ...(table === 'chunks' ? { embedding: null } : { created_at: '2026-11-19T20:00:00Z' }),
      ...row, id: db.nextId[table]++ }));
    rows.push(...created);
    return reply(created, 201);
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(init.body);
    const updated = rows.filter(match);
    for (const row of updated) Object.assign(row, patch);
    return reply(updated);
  }
  if (method === 'DELETE') {
    if (db.failDelete) return Response.json({ message: 'delete failed' }, { status: 500 });
    const removed = rows.filter(match);
    db[table] = rows.filter(row => !match(row));
    return reply(removed);
  }
  throw new Error(`nieobsłużone ${method} ${url}`);
}

const cookie = async () => `workshop-session=${await createSession(authConfig())}`;
const uploadRequest = async (body) => new Request('http://localhost:3000/api/upload', {
  method: 'POST', body: JSON.stringify(body), headers: { origin: 'http://localhost:3000',
    'content-type': 'application/json', cookie: await cookie() },
});
const deleteRequest = async (query, { session = true, origin = 'http://localhost:3000' } = {}) =>
  new Request(`http://localhost:3000/api/upload?${query}`, { method: 'DELETE',
    headers: { origin, ...(session ? { cookie: await cookie() } : {}) } });
async function events(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const all = [];
  await readUploadEvents(response.body, event => all.push(event));
  return all;
}
const seedOld = () => {
  db.documents.push({ id: 50, title: 'Regulamin', created_at: '2026-11-01T10:00:00Z' });
  db.chunks.push(
    { id: 10, document_id: 50, chunk_index: 0, content: 'Stara wersja A.', embedding: vector(500) },
    { id: 11, document_id: 50, chunk_index: 1, content: 'Stara wersja B.', embedding: vector(501) },
  );
};

test('sukces: etapy po kolei, jedno embedMany, fragmenty zapisane z wektorami', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  const all = await events(await upload(await uploadRequest({ title: 'Regulamin', content: 'Pierwszy akapit.\n\nDrugi akapit.\n\nTrzeci.' })));
  assert.deepEqual(all.slice(0, 3), [{ type: 'stage', stage: 'split' }, { type: 'stage', stage: 'embed' }, { type: 'stage', stage: 'save' }]);
  assert.equal(all.length, 4);
  assert.equal(all[3].type, 'done');
  assert.deepEqual(all[3].document, { id: 1, title: 'Regulamin', created_at: '2026-11-19T20:00:00Z', chunks: 3,
    backfilled: 0, backfillFailed: 0, replaced: 0, replaceFailed: 0 });
  assert.equal(embedCalls.length, 1);
  assert.deepEqual(embedCalls[0], ['Pierwszy akapit.', 'Drugi akapit.', 'Trzeci.']);
  assert.deepEqual(db.chunks.map(chunk => [chunk.document_id, chunk.chunk_index, chunk.content]),
    [[1, 0, 'Pierwszy akapit.'], [1, 1, 'Drugi akapit.'], [1, 2, 'Trzeci.']]);
  for (const [index, chunk] of db.chunks.entries()) assert.deepEqual(chunk.embedding, vector(index));
});

test('etapy odpowiadają prawdziwej pracy: embed przed modelem, save przed zapisem', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  await saveDocument({ title: 'X', content: 'Tekst.' }, { onStage: stage => log.push(`stage:${stage}`) });
  assert.deepEqual(log, ['stage:split', 'stage:embed', 'GET chunks', 'embeddings', 'stage:save', 'POST documents', 'POST chunks']);
  assert.deepEqual(Object.values(STAGE_LABELS), ['Dzielę tekst…', 'Tworzę embeddingi…', 'Zapisuję…']);
});

test('błąd embeddingów: etap embed, komunikat po polsku, nic nie zapisane', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  embedResponse = () => Response.json({ error: { message: 'Invalid model', code: 400 } }, { status: 400 });
  const all = await events(await upload(await uploadRequest({ title: 'Cennik', content: 'Akapit jeden.\n\nAkapit dwa.' })));
  const last = all.at(-1);
  assert.deepEqual(last, { type: 'error', stage: 'embed', message: KB_MESSAGES.embeddings });
  assert.match(last.message, /Nic nie zostało zapisane\. Spróbuj ponownie/);
  assert.equal(all.some(event => event.type === 'done'), false);
  assert.deepEqual(db.documents, []);
  assert.deepEqual(db.chunks, []);
});

test('zła długość wektora i błąd zapisu fragmentów nie zostawiają dokumentu', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  embedResponse = (input) => Response.json({ object: 'list', model: 'x',
    data: input.map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2] })) });
  await assert.rejects(saveDocument({ title: 'Krótkie', content: 'Tekst.' }), { message: KB_MESSAGES.embeddings, stage: 'embed' });
  assert.deepEqual(db.documents, []);
  embedResponse = (input) => Response.json({ object: 'list', model: 'x',
    data: input.map((_, index) => ({ object: 'embedding', index, embedding: vector(index) })) });
  db.failChunkInsert = true;
  await assert.rejects(saveDocument({ title: 'X', content: 'Tekst.' }), { message: KB_MESSAGES.chunks, stage: 'save' });
  assert.deepEqual(db.documents, []);
});

test('ten sam tytuł bez potwierdzenia: 409 z poprzednią wersją, nic nie robimy', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  seedOld();
  const response = await upload(await uploadRequest({ title: 'Regulamin', content: 'Nowa treść.' }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { existing: [{ id: 50, title: 'Regulamin', created_at: '2026-11-01T10:00:00Z', chunks: 2 }] });
  assert.equal(embedCalls.length, 0);
  assert.equal(db.documents.length, 1);
  assert.equal(db.chunks.length, 2);
});

test('zastąpienie po potwierdzeniu: zostają tylko nowe fragmenty', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  seedOld();
  const all = await events(await upload(await uploadRequest({ title: 'Regulamin', content: 'Nowa A.\n\nNowa B.\n\nNowa C.', replace: true })));
  assert.equal(all.at(-1).type, 'done');
  assert.equal(all.at(-1).document.replaced, 1);
  assert.deepEqual(db.documents.map(doc => doc.title), ['Regulamin']);
  assert.notEqual(db.documents[0].id, 50);
  assert.deepEqual(db.chunks.map(chunk => chunk.content), ['Nowa A.', 'Nowa B.', 'Nowa C.']);
  assert.ok(db.chunks.every(chunk => chunk.document_id === db.documents[0].id && chunk.embedding));
});

test('zastąpienie: nieudany import nie narusza poprzedniej wersji', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  seedOld();
  const before = structuredClone({ documents: db.documents, chunks: db.chunks });
  embedResponse = () => Response.json({ error: { message: 'down', code: 400 } }, { status: 400 });
  const failedEmbed = (await events(await upload(await uploadRequest({ title: 'Regulamin', content: 'Nowa.', replace: true })))).at(-1);
  assert.equal(failedEmbed.stage, 'embed');
  assert.match(failedEmbed.message, /Poprzednia wersja dokumentu pozostała bez zmian/);
  assert.deepEqual({ documents: db.documents, chunks: db.chunks }, before);

  embedResponse = (input) => Response.json({ object: 'list', model: 'x',
    data: input.map((_, index) => ({ object: 'embedding', index, embedding: vector(index) })) });
  db.failChunkInsert = true;
  const failedSave = (await events(await upload(await uploadRequest({ title: 'Regulamin', content: 'Nowa.', replace: true })))).at(-1);
  assert.equal(failedSave.stage, 'save');
  assert.match(failedSave.message, /Poprzednia wersja dokumentu pozostała bez zmian/);
  assert.deepEqual({ documents: db.documents, chunks: db.chunks }, before);
});

test('usuwanie: sesja, ten sam origin, poprawny identyfikator, dokument z fragmentami', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  seedOld();
  assert.equal((await remove(await deleteRequest('document=50', { session: false }))).status, 401);
  assert.equal((await remove(await deleteRequest('document=50', { origin: 'https://evil.example' }))).status, 403);
  for (const query of ['document=abc', 'document=0', 'document=1.5', '']) {
    assert.equal((await remove(await deleteRequest(query))).status, 400);
  }
  assert.equal(log.length, 0, 'bez sesji, z obcego originu i ze złym id nie dotykamy bazy');
  assert.equal((await remove(await deleteRequest('document=50'))).status, 204);
  assert.deepEqual(db.documents, []);
  assert.deepEqual(db.chunks, []);
  const missing = await remove(await deleteRequest('document=50'));
  assert.equal(missing.status, 404);
  db.failDelete = true;
  seedOld();
  const failed = await remove(await deleteRequest('document=50'));
  assert.equal(failed.status, 503);
  assert.match(await failed.text(), /Nie udało się usunąć dokumentu/);
});

test('lista dokumentów: tytuł, data wersji i liczba fragmentów, najnowsze najpierw', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  seedOld();
  db.documents.push({ id: 51, title: 'Cennik', created_at: '2026-11-18T09:00:00Z' });
  assert.deepEqual(await listDocuments(), [
    { id: 51, title: 'Cennik', created_at: '2026-11-18T09:00:00Z', chunks: 0 },
    { id: 50, title: 'Regulamin', created_at: '2026-11-01T10:00:00Z', chunks: 2 },
  ]);
});

test('uzupełnia puste embeddingi starszych fragmentów w tym samym wywołaniu', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  db.documents.push({ id: 50, title: 'Stary', created_at: '2026-11-01T10:00:00Z' });
  db.chunks.push(
    { id: 10, document_id: 50, chunk_index: 0, content: 'Stary bez wektora A.', embedding: null },
    { id: 11, document_id: 50, chunk_index: 1, content: 'Stary z wektorem.', embedding: vector(999) },
    { id: 12, document_id: 50, chunk_index: 2, content: 'Stary bez wektora B.', embedding: null },
  );
  const result = await saveDocument({ title: 'Nowy', content: 'Nowy akapit.' });
  assert.equal(result.backfilled, 2);
  assert.equal(embedCalls.length, 1);
  assert.deepEqual(embedCalls[0], ['Nowy akapit.', 'Stary bez wektora A.', 'Stary bez wektora B.']);
  const byId = Object.fromEntries(db.chunks.map(chunk => [chunk.id, chunk]));
  assert.deepEqual(byId[10].embedding, vector(1));
  assert.deepEqual(byId[11].embedding, vector(999));
  assert.deepEqual(byId[12].embedding, vector(2));
});

test('uzupełnianie jest ograniczone do BACKFILL_LIMIT fragmentów na import', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  for (let i = 0; i < BACKFILL_LIMIT + 5; i++) {
    db.chunks.push({ id: 1000 + i, document_id: 50, chunk_index: i, content: `Stary ${i}.`, embedding: null });
  }
  const result = await saveDocument({ title: 'Nowy', content: 'Nowy.' });
  assert.equal(result.backfilled, BACKFILL_LIMIT);
  assert.equal(embedCalls[0].length, BACKFILL_LIMIT + 1);
  assert.equal(db.chunks.filter(chunk => chunk.embedding == null).length, 5);
});

test('readUploadEvents: zdarzenia pocięte w dowolnym miejscu i urwany strumień', async () => {
  const text = '{"type":"stage","stage":"split"}\n{"type":"stage","stage":"embed"}\n{"type":"error","stage":"embed","message":"Błąd"}\n';
  const bytes = new TextEncoder().encode(text);
  const stream = (parts) => new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
  const seen = [];
  const last = await readUploadEvents(stream([bytes.slice(0, 7), bytes.slice(7, 40), bytes.slice(40)]), event => seen.push(event.stage));
  assert.deepEqual(seen, ['split', 'embed', 'embed']);
  assert.deepEqual(last, { type: 'error', stage: 'embed', message: 'Błąd' });
  const cut = new TextEncoder().encode('{"type":"stage","stage":"split"}\n{"type":"stage","stage":"embed"}\n');
  assert.equal(await readUploadEvents(stream([cut]), () => {}), null);
});
