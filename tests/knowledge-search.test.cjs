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
  OPENROUTER_API_KEY: 'fake-openrouter-key', OPENROUTER_EMBEDDING_MODEL: 'test/embedding-model',
  SUPABASE_URL: 'http://supabase.test', SUPABASE_SECRET_KEY: 'fake-supabase-key' });
const { searchKnowledgeBase, KB_MATCH_COUNT } = require('../lib/knowledge-search.ts');
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
  ]);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'openrouter.ai') {
      if (embedStatus !== 200) return Response.json({ error: { message: 'down' } }, { status: embedStatus });
      return Response.json({ object: 'list', model: 'test/embedding-model',
        data: [{ object: 'embedding', index: 0, embedding: Array(EMBEDDING_DIMENSIONS).fill(0.01) }] });
    }
    assert.equal(url.href, 'http://supabase.test/rest/v1/rpc/match_chunks');
    rpcBody = JSON.parse(init.body);
    return rpcReply();
  };
});

test('bazaWiedzy: embedding pytania → match_chunks → tylko trafne fragmenty ze źródłem', async () => {
  const result = await searchKnowledgeBase({ pytanie: 'ile kosztuje pakiet start?' });
  assert.equal(rpcBody.match_count, KB_MATCH_COUNT);
  assert.equal(rpcBody.query_embedding.length, EMBEDDING_DIMENSIONS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.fragmenty, [{ zrodlo: 'Cennik 2026', tresc: 'Pakiet Start kosztuje 490 zł netto miesięcznie.', podobienstwo: 0.71 }]);
});

test('bazaWiedzy: brak trafień daje ok=true z komunikatem, a nie zmyślone dane', async () => {
  rpcReply = () => Response.json([]);
  const result = await searchKnowledgeBase({ pytanie: 'pogoda w Krakowie' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.fragmenty, []);
  assert.match(result.komunikat, /nie ma fragmentów/);
});

test('bazaWiedzy: awaria embeddingów albo bazy daje czytelny błąd', async () => {
  embedStatus = 500;
  assert.equal((await searchKnowledgeBase({ pytanie: 'pakiet start' })).ok, false);
  embedStatus = 200;
  rpcReply = () => Response.json({ message: 'boom' }, { status: 500 });
  const result = await searchKnowledgeBase({ pytanie: 'pakiet start' });
  assert.equal(result.ok, false);
  assert.match(result.komunikat, /bazy wiedzy/);
});

test('bazaWiedzy jest w narzędziach czatu, ma plakietkę i pierwszeństwo przed internetem w instrukcji', () => {
  assert.ok(createAgentTools('scope').bazaWiedzy);
  assert.ok(TOOL_LABELS.bazaWiedzy);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Baza wiedzy ma pierwszeństwo przed internetem/);
});
