// Pruebas del presupuesto de IA (límites, tokens, caché). Correr con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  limitsFromEnv,
  getUsage,
  quotaError,
  reserveRequest,
  tokenCounts,
  recordCall,
  TtlCache,
  cacheKey,
} = require('../lib/ai-budget');

const DAY = '2026-10-15';

test('limitsFromEnv usa valores por defecto y acepta overrides', () => {
  const d = limitsFromEnv({});
  assert.equal(d.dailyRequests, 40);
  assert.equal(d.dailyTokens, 200000);
  assert.equal(d.cacheTtlMs, 360 * 60 * 1000);

  const c = limitsFromEnv({ AI_DAILY_REQUEST_LIMIT: '3', AI_DAILY_TOKEN_LIMIT: '500', AI_CACHE_TTL_MIN: '0' });
  assert.equal(c.dailyRequests, 3);
  assert.equal(c.dailyTokens, 500);
  assert.equal(c.cacheTtlMs, 0);
});

test('limitsFromEnv ignora valores inválidos y usa el default', () => {
  const l = limitsFromEnv({ AI_DAILY_REQUEST_LIMIT: 'abc', AI_DAILY_TOKEN_LIMIT: '-5', AI_CACHE_TTL_MIN: '' });
  assert.equal(l.dailyRequests, 40);
  assert.equal(l.dailyTokens, 200000);
  assert.equal(l.cacheTtlMs, 360 * 60 * 1000);
});

test('getUsage reinicia contadores cuando cambia el día y conserva el registro', () => {
  const store = { day: '2026-10-14', requests: 9, tokens: 999, log: [{ kind: 'x' }] };
  const u = getUsage(store, DAY);
  assert.equal(u.requests, 0);
  assert.equal(u.tokens, 0);
  assert.equal(u.log.length, 1);
  assert.deepEqual(getUsage(undefined, DAY).log, []);
});

test('quotaError bloquea al llegar al límite de consultas y de tokens', () => {
  const limits = { dailyRequests: 2, dailyTokens: 100 };
  assert.equal(quotaError({ requests: 1, tokens: 99 }, limits), null);
  assert.match(quotaError({ requests: 2, tokens: 0 }, limits), /consultas/);
  assert.match(quotaError({ requests: 0, tokens: 100 }, limits), /tokens/);
});

test('reserveRequest suma una consulta sin tocar el original', () => {
  const store = { day: DAY, requests: 1, tokens: 5, log: [] };
  const r = reserveRequest(store, DAY);
  assert.equal(r.requests, 2);
  assert.equal(store.requests, 1);
});

test('tokenCounts usa los tokens reales del proveedor', () => {
  const t = tokenCounts({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, [], '');
  assert.deepEqual(t, { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false });
});

test('tokenCounts estima por caracteres si el proveedor no informa uso', () => {
  const msgs = [{ role: 'user', content: 'a'.repeat(40) }];
  const t = tokenCounts(undefined, msgs, 'b'.repeat(8));
  assert.equal(t.estimated, true);
  assert.equal(t.completionTokens, 2);
  assert.equal(t.totalTokens, t.promptTokens + t.completionTokens);
});

test('recordCall suma tokens y agrega una línea al registro', () => {
  const r = recordCall({ day: DAY, requests: 1, tokens: 10, log: [] }, DAY, {
    kind: 'coach', model: 'plus', ok: true, promptTokens: 30, completionTokens: 20, totalTokens: 50,
  });
  assert.equal(r.tokens, 60);
  assert.equal(r.requests, 1);
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0].kind, 'coach');
  assert.equal(r.log[0].cached, false);
});

test('una respuesta desde caché no gasta tokens', () => {
  const r = recordCall({ day: DAY, requests: 1, tokens: 10, log: [] }, DAY, {
    kind: 'coach', model: 'plus', cached: true, totalTokens: 999,
  });
  assert.equal(r.tokens, 10);
  assert.equal(r.log[0].cached, true);
  assert.equal(r.log[0].totalTokens, 0);
});

test('el registro se acota a MAX_LOG entradas', () => {
  let s = { day: DAY, requests: 0, tokens: 0, log: [] };
  for (let i = 0; i < 260; i++) s = recordCall(s, DAY, { kind: 'k' + i, ok: false });
  assert.equal(s.log.length, 200);
  assert.equal(s.log[s.log.length - 1].kind, 'k259');
});

test('TtlCache devuelve el valor dentro del TTL y lo descarta después', () => {
  let now = 1000;
  const c = new TtlCache({ ttlMs: 100, max: 10, now: () => now });
  c.set('a', 'valor');
  assert.equal(c.get('a'), 'valor');
  now = 1101;
  assert.equal(c.get('a'), undefined);
});

test('TtlCache con ttl 0 no guarda nada', () => {
  const c = new TtlCache({ ttlMs: 0, max: 10 });
  c.set('a', 'valor');
  assert.equal(c.get('a'), undefined);
});

test('TtlCache descarta la entrada más antigua al pasar el tope', () => {
  const c = new TtlCache({ ttlMs: 1e9, max: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});

test('cacheKey separa sesiones distintas aunque el prompt sea igual', () => {
  const msgs = [{ role: 'user', content: 'hola' }];
  assert.notEqual(cacheKey('sesion-1', 'plus', msgs), cacheKey('sesion-2', 'plus', msgs));
  assert.equal(cacheKey('sesion-1', 'plus', msgs), cacheKey('sesion-1', 'plus', msgs));
});
