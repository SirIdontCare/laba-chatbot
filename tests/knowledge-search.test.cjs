const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
// Fałszywe adresy i klucze; każdy fetch jest atrapą, nic nie trafia do OpenRouter ani Supabase.
Object.assign(process.env, { NODE_ENV: 'development',
  OPENROUTER_API_KEY: 'fake-openrouter-key', OPENROUTER_EMBEDDING_MODEL: 'test/embedding-model' });
const { testUser, USER_DB_URL, USER_DB_TOKEN } = require('./fake-auth.cjs');
// match_chunks wołamy bazą zalogowanej osoby (RLS + security invoker), nigdy kluczem secret.
const owner = testUser();
const { searchKnowledgeBase, KB_MATCH_COUNT } = require('../lib/knowledge-search.ts');
const { KB_MIN_SIMILARITY, citedTitles, usedKnowledgeFragments } = require('../lib/knowledge-schema.ts');
const { createAgentTools } = require('../lib/agent-tools.ts');
const { TOOL_LABELS } = require('../lib/tool-catalog.ts');
const { AGENT_CHAT_INSTRUCTIONS } = require('../lib/studio-nova.ts');
const { EMBEDDING_DIMENSIONS } = require('../lib/model.ts');

let rpcBody, rpcReply, embedStatus;
beforeEach(() => {
  rpcBody = null;
  embedStatus = 200;
  rpcReply = () => Response.json([
    { id: 1, document_id: 1, title: 'Cennik 2026', content: 'Pakiet Start kosztuje 490 zł netto miesięcznie.', similarity: 0.71234 },
    { id: 2, document_id: 2, title: 'FAQ', content: 'Nie na temat.', similarity: 0.1 },
    { id: 3, document_id: 3, title: 'Regulamin', content: 'Okres próbny trwa 14 dni.', similarity: 0.5 },
    { id: 4, document_id: 2, title: 'FAQ', content: 'Czwarty fragment.', similarity: 0.05 },
  ]);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'openrouter.ai') {
      if (embedStatus !== 200) return Response.json({ error: { message: 'down' } }, { status: embedStatus });
      return Response.json({ object: 'list', model: 'test/embedding-model',
        data: [{ object: 'embedding', index: 0, embedding: Array(EMBEDDING_DIMENSIONS).fill(0.01) }] });
    }
    assert.equal(url.href, `${USER_DB_URL}/rest/v1/rpc/match_chunks`);
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${USER_DB_TOKEN}`);
    rpcBody = JSON.parse(init.body);
    return rpcReply();
  };
});

test('searchKnowledge: embedding pytania → match_chunks → do 3 najlepszych fragmentów powyżej progu', async () => {
  const result = await searchKnowledgeBase(owner, { pytanie: 'ile kosztuje pakiet start?' });
  assert.equal(KB_MATCH_COUNT, 3);
  assert.equal(KB_MIN_SIMILARITY, 0.45);
  assert.equal(rpcBody.match_count, 3);
  assert.equal(rpcBody.query_embedding.length, EMBEDDING_DIMENSIONS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.fragmenty, [
    { tytul: 'Cennik 2026', tresc: 'Pakiet Start kosztuje 490 zł netto miesięcznie.', podobienstwo: 0.71 },
    { tytul: 'Regulamin', tresc: 'Okres próbny trwa 14 dni.', podobienstwo: 0.5 },
  ]);
});

test('searchKnowledge: same fragmenty poniżej progu = brak źródeł i komunikat', async () => {
  rpcReply = () => Response.json([{ id: 9, document_id: 2, title: 'FAQ', content: 'Pogoda.', similarity: 0.32 }]);
  const result = await searchKnowledgeBase(owner, { pytanie: 'pogoda w Krakowie' });
  assert.deepEqual(result.fragmenty, []);
  assert.match(result.komunikat, /wystarczająco podobnych/);
});

test('źródła pod odpowiedzią: tylko fragmenty z dokumentów z linii 📎 Źródło, bez podobnych tytułów', () => {
  assert.deepEqual([...citedTitles('Tekst.\n📎 Źródło: [Cennik 2026 v2]')], ['Cennik 2026 v2']);
  assert.ok(citedTitles('📎 Źródła: Cennik 2026, FAQ').has('FAQ'));
  const output = { ok: true, pobranoAt: new Date().toISOString(), fragmenty: [
    { tytul: 'Cennik 2026', tresc: 'Start 490 zł.', podobienstwo: 0.63 },
    { tytul: 'Cennik 2026 v2', tresc: 'Start 540 zł.', podobienstwo: 0.62 },
    { tytul: 'FAQ', tresc: 'Okres próbny 14 dni.', podobienstwo: 0.6 },
  ] };
  assert.deepEqual(usedKnowledgeFragments([output, output], 'Start kosztuje 540 zł.\n📎 Źródło: Cennik 2026 v2'),
    [{ tytul: 'Cennik 2026 v2', tresc: 'Start 540 zł.', podobienstwo: 0.62 }]);
  assert.deepEqual(usedKnowledgeFragments([output], 'Nie mam tej informacji w bazie wiedzy.'), []);
  const weak = { ...output, fragmenty: [{ tytul: 'FAQ', tresc: 'x', podobienstwo: 0.3 }] };
  assert.deepEqual(usedKnowledgeFragments([weak], '📎 Źródło: FAQ'), []);
});

test('searchKnowledge: brak trafień daje ok=true z komunikatem, a nie zmyślone dane', async () => {
  rpcReply = () => Response.json([]);
  const result = await searchKnowledgeBase(owner, { pytanie: 'pogoda w Krakowie' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.fragmenty, []);
  assert.match(result.komunikat, /nie ma fragmentów/);
});

test('searchKnowledge: awaria embeddingów albo bazy daje czytelny błąd', async () => {
  embedStatus = 500;
  assert.equal((await searchKnowledgeBase(owner, { pytanie: 'pakiet start' })).ok, false);
  embedStatus = 200;
  rpcReply = () => Response.json({ message: 'boom' }, { status: 500 });
  const result = await searchKnowledgeBase(owner, { pytanie: 'pakiet start' });
  assert.equal(result.ok, false);
  assert.match(result.komunikat, /bazy wiedzy/);
});

test('searchKnowledge bez zalogowanej osoby odmawia i nie łączy się z bazą', async () => {
  rpcBody = null;
  const result = await searchKnowledgeBase(null, { pytanie: 'pakiet start' });
  assert.equal(result.ok, false);
  assert.equal(rpcBody, null);
});

test('searchKnowledge jest w narzędziach czatu, ma plakietkę, opis i zasady w instrukcji', () => {
  const tools = createAgentTools('scope');
  assert.ok(tools.searchKnowledge);
  assert.equal(tools.bazaWiedzy, undefined);
  assert.ok(TOOL_LABELS.searchKnowledge);
  assert.match(tools.searchKnowledge.description, /firmę, ofertę, ceny, zasady i regulamin/);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /wyłącznie na podstawie fragmentów zwróconych przez searchKnowledge/);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /📎 Źródło: \[tytuł dokumentu\]/);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Nie mam tej informacji w bazie wiedzy/);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /ani z wyszukiwarki internetowej/);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Fragment na podobny temat to jeszcze nie odpowiedź/);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /czego brakuje w bazie wiedzy/);
  assert.equal(TOOL_LABELS.searchKnowledge, '📚 baza wiedzy');
});

test('endpoint agenta sprawdza sesję, zanim uruchomi czat z narzędziami', () => {
  const route = readFileSync(require.resolve('../app/api/agent/route.ts'), 'utf8');
  assert.ok(route.indexOf('requestUser(request)') < route.indexOf('agentChat(request'));
});
