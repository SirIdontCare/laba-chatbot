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
const { saveDocument, KB_MESSAGES, BACKFILL_LIMIT } = require('../lib/knowledge-base.ts');
const { EMBEDDING_DIMENSIONS } = require('../lib/model.ts');
const { POST: upload } = require('../app/api/upload/route.ts');
const { authConfig, createSession } = require('../lib/session.ts');

const vector = (seed) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (seed + i) / 10_000);

// Minimalna atrapa PostgREST (tabele documents i chunks) i endpointu embeddingów OpenRouter.
let db, embedCalls, embedResponse;
beforeEach(() => {
  db = { documents: [], chunks: [], nextId: { documents: 1, chunks: 100 } };
  embedCalls = [];
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

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.hostname === 'openrouter.ai') {
    assert.equal(url.pathname, '/api/v1/embeddings');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'test/embedding-model');
    embedCalls.push(body.input);
    return embedResponse(body.input);
  }
  assert.equal(url.hostname, 'supabase.test', `nieoczekiwany adres ${url}`);
  const table = url.pathname.replace('/rest/v1/', '');
  const rows = db[table];
  const match = filters(url);
  const headers = new Headers(init.headers);
  const single = headers.get('accept') === 'application/vnd.pgrst.object+json';
  const reply = (data, status = 200) => headers.get('prefer')?.includes('return=minimal')
    ? new Response(null, { status: 204 })
    : Response.json(single ? data[0] : data, { status });
  if (method === 'GET') {
    let found = rows.filter(match).sort((a, b) => a.id - b.id);
    if (url.searchParams.has('limit')) found = found.slice(0, Number(url.searchParams.get('limit')));
    return reply(found);
  }
  if (method === 'POST') {
    const body = [JSON.parse(init.body)].flat();
    if (table === 'chunks' && db.failChunkInsert) return Response.json({ message: 'insert failed' }, { status: 500 });
    const created = body.map(row => ({ embedding: null, ...row, id: db.nextId[table]++ }));
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
    db[table] = rows.filter(row => !match(row));
    return reply([]);
  }
  throw new Error(`nieobsłużone ${method} ${url}`);
}

const uploadRequest = async (body) => new Request('http://localhost:3000/api/upload', {
  method: 'POST', body: JSON.stringify(body), headers: { origin: 'http://localhost:3000',
    'content-type': 'application/json', cookie: `workshop-session=${await createSession(authConfig())}` },
});

test('sukces: jedno wywołanie embedMany, fragmenty zapisane z wektorami', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  const result = await saveDocument({ title: 'Regulamin', content: 'Pierwszy akapit.\n\nDrugi akapit.\n\nTrzeci.' });
  assert.deepEqual(result, { id: 1, title: 'Regulamin', chunks: 3, backfilled: 0, backfillFailed: 0 });
  assert.equal(embedCalls.length, 1);
  assert.deepEqual(embedCalls[0], ['Pierwszy akapit.', 'Drugi akapit.', 'Trzeci.']);
  assert.equal(db.documents.length, 1);
  assert.deepEqual(db.chunks.map(chunk => [chunk.document_id, chunk.chunk_index, chunk.content]),
    [[1, 0, 'Pierwszy akapit.'], [1, 1, 'Drugi akapit.'], [1, 2, 'Trzeci.']]);
  for (const [index, chunk] of db.chunks.entries()) assert.deepEqual(chunk.embedding, vector(index));
});

test('błąd embeddingów: dokument i fragmenty usunięte, komunikat po polsku bez „Zapisano”', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  embedResponse = () => Response.json({ error: { message: 'Invalid model', code: 400 } }, { status: 400 });
  const response = await upload(await uploadRequest({ title: 'Cennik', content: 'Akapit jeden.\n\nAkapit dwa.' }));
  assert.equal(response.status, 503);
  const message = await response.text();
  assert.equal(message, KB_MESSAGES.embeddings);
  assert.match(message, /Nie udało się .*embeddingów.*Dokument nie został zapisany/);
  assert.doesNotMatch(message, /Zapisano/);
  assert.equal(embedCalls.length, 1);
  assert.deepEqual(db.documents, []);
  assert.deepEqual(db.chunks, []);
});

test('zła długość wektora też usuwa dokument', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  embedResponse = (input) => Response.json({ object: 'list', model: 'x',
    data: input.map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2] })) });
  await assert.rejects(saveDocument({ title: 'Krótkie', content: 'Tekst.' }), { message: KB_MESSAGES.embeddings });
  assert.deepEqual(db.documents, []);
  assert.deepEqual(db.chunks, []);
});

test('błąd zapisu fragmentów usuwa dokument', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  db.failChunkInsert = true;
  await assert.rejects(saveDocument({ title: 'X', content: 'Tekst.' }), { message: KB_MESSAGES.chunks });
  assert.deepEqual(db.documents, []);
});

test('uzupełnia puste embeddingi starszych fragmentów w tym samym wywołaniu', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch);
  db.documents.push({ id: 50, title: 'Stary' });
  db.chunks.push(
    { id: 10, document_id: 50, chunk_index: 0, content: 'Stary bez wektora A.', embedding: null },
    { id: 11, document_id: 50, chunk_index: 1, content: 'Stary z wektorem.', embedding: vector(999) },
    { id: 12, document_id: 50, chunk_index: 2, content: 'Stary bez wektora B.', embedding: null },
  );
  const response = await upload(await uploadRequest({ title: 'Nowy', content: 'Nowy akapit.' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 1, title: 'Nowy', chunks: 1, backfilled: 2, backfillFailed: 0 });
  assert.equal(embedCalls.length, 1);
  assert.deepEqual(embedCalls[0], ['Nowy akapit.', 'Stary bez wektora A.', 'Stary bez wektora B.']);
  const byId = Object.fromEntries(db.chunks.map(chunk => [chunk.id, chunk]));
  assert.deepEqual(byId[10].embedding, vector(1));
  assert.deepEqual(byId[11].embedding, vector(999));
  assert.deepEqual(byId[12].embedding, vector(2));
  assert.equal(db.chunks.filter(chunk => chunk.embedding == null).length, 0);
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
