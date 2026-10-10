/**
 * Self-check for the pool's rotation logic. Runs the real plugin against a fake
 * context and a fake usage endpoint, and pins the four behaviors that matter:
 * a spent key is avoided before the request, a refused request fails over and
 * re-dispatches, an all-spent pool gives up after the failover budget, and
 * requests for other provider routes are returned untouched.
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'

const REF_A = 'OPENCODE_GO_API_KEY'
const REF_B = 'OPENCODE_GO_API_KEY_B'
const ACTIVE = 'OPENCODE_GO_ACTIVE_KEY'
const KEY_A = 'oc_sk_test_key_a'
const KEY_B = 'oc_sk_test_key_b'

const HEALTHY = { usage: { rolling: { status: 'ok', percent: 3 }, weekly: { status: 'ok', percent: 11 }, monthly: { status: 'ok', percent: 5 } } }
const SPENT = {
  usage: {
    rolling: { status: 'ok', percent: 28, resetsAt: '2026-10-10T16:16:11.000Z' },
    weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 94, resetsAt: '2026-10-25T08:05:57.000Z' },
  },
}
const REFUSAL = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      code: 'QUOTA',
      status: 429,
      message: 'Go usage limit exceeded',
      providerRetryAfterMs: 118_313_000,
    },
  },
}
const SUCCESS = { type: 'finish', reason: { kind: 'stop' } }

/**
 * Build one fake context with a credential store and a captured handler set.
 * @param values - initial credential values.
 * @returns the context, its handlers, its store, and recorded writes and logs.
 */
function makeContext(values) {
  const handlers = new Map()
  const store = new Map(Object.entries(values))
  const sets = []
  const logs = []
  const seam = {
    resolve: async ref => (store.has(ref) ? { value: store.get(ref) } : undefined),
    set: async (ref, value) => { store.set(ref, value); sets.push([ref, value]) },
  }
  const ctx = {
    logger: {
      info: message => logs.push(['info', message]),
      warn: message => logs.push(['warn', message]),
    },
    get: name => (name === 'credentials' ? seam : undefined),
    on: (event, handler) => { handlers.set(event, handler) },
  }
  return { ctx, handlers, store, sets, logs }
}

/**
 * Install the pool with the test configuration.
 * @param values - initial credential values.
 * @param overrides - extra config fields.
 * @returns the fake context and the registered stream handler.
 */
function setup(values, overrides = {}) {
  const fake = makeContext(values)
  apply(fake.ctx, {
    route: 'opencode-go',
    activeRef: ACTIVE,
    keys: [{ ref: REF_A, label: 'A' }, { ref: REF_B, label: 'B' }],
    usageTtlMs: 60_000,
    cooldownMs: 60_000,
    ...overrides,
  })
  return { ...fake, stream: fake.handlers.get('llm/stream') }
}

/**
 * Replace the global fetch with a usage endpoint over the given key readings.
 * @param readings - map of API key to a reading or a function of the query index.
 * @returns the recorded Authorization headers.
 */
function stubUsage(readings) {
  const seen = []
  const counts = new Map()
  globalThis.fetch = async (_url, init) => {
    const key = String(init.headers.Authorization).replace(/^Bearer /, '')
    seen.push(key)
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    const entry = readings[key]
    const body = typeof entry === 'function' ? entry(count) : entry
    if (body === undefined) return { ok: false, status: 403, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  }
  return seen
}

/**
 * Drain one pooled stream.
 * @param iterable - the returned chunk stream.
 * @returns the yielded chunks.
 */
async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

// 1. A spent key never reaches the wire: the request is served by the healthy one.
{
  stubUsage({ [KEY_A]: SPENT, [KEY_B]: HEALTHY })
  const { stream, store, logs } = setup({ [REF_A]: KEY_A, [REF_B]: KEY_B })
  let calls = 0
  const chunks = await collect(stream({ provider: 'opencode-go' }, () => {
    calls += 1
    return (async function* () { yield { type: 'text', text: 'hi' }; yield SUCCESS })()
  }))
  assert.equal(calls, 1)
  assert.equal(store.get(ACTIVE), KEY_B)
  assert.deepEqual(chunks.at(-1), SUCCESS)
  assert.ok(logs.some(([, message]) => message.includes('installed B')), 'expected an install log line')
}

// 2. A newly installed key is used as-is when it is the healthy one.
{
  stubUsage({ [KEY_A]: SPENT, [KEY_B]: HEALTHY })
  const { stream, store, sets } = setup({ [REF_A]: KEY_A, [REF_B]: KEY_B, [ACTIVE]: KEY_A })
  let calls = 0
  const chunks = await collect(stream({ provider: 'opencode-go' }, () => {
    calls += 1
    return (async function* () { yield SUCCESS })()
  }))
  assert.equal(calls, 1)
  assert.equal(store.get(ACTIVE), KEY_B)
  assert.deepEqual(sets, [[ACTIVE, KEY_B]])
  assert.deepEqual(chunks, [SUCCESS])
}

// 3. A cold pool that meets a refusal fails over and re-dispatches the request.
{
  // The first reading claims A is healthy, so the request goes out on A; the
  // forced re-read after the refusal sees the spent window.
  stubUsage({ [KEY_A]: count => (count === 1 ? HEALTHY : SPENT), [KEY_B]: HEALTHY })
  const { stream, store, logs } = setup({ [REF_A]: KEY_A, [REF_B]: KEY_B, [ACTIVE]: KEY_A })
  let calls = 0
  const chunks = await collect(stream({ provider: 'opencode-go' }, () => {
    calls += 1
    return (async function* () {
      if (calls === 1) { yield REFUSAL; return }
      yield { type: 'text', text: 'recovered' }
      yield SUCCESS
    })()
  }))
  assert.equal(calls, 2, 'the refused request must be re-dispatched once')
  assert.equal(store.get(ACTIVE), KEY_B)
  assert.deepEqual(chunks, [{ type: 'text', text: 'recovered' }, SUCCESS])
  assert.ok(logs.some(([, message]) => message.includes('failover A')), 'expected a failover log line')
}

// 4. Output already on the wire is never duplicated: the refusal is surfaced.
{
  stubUsage({ [KEY_A]: SPENT, [KEY_B]: SPENT })
  const { stream } = setup({ [REF_A]: KEY_A, [REF_B]: KEY_B, [ACTIVE]: KEY_A }, { maxFailovers: 0 })
  let calls = 0
  const chunks = await collect(stream({ provider: 'opencode-go' }, () => {
    calls += 1
    return (async function* () {
      if (calls === 1) { yield { type: 'text', text: 'partial' }; yield REFUSAL; return }
      yield SUCCESS
    })()
  }))
  assert.equal(calls, 1)
  assert.deepEqual(chunks, [{ type: 'text', text: 'partial' }, REFUSAL])
}

// 5. An all-spent pool stops after the failover budget instead of looping.
{
  stubUsage({ [KEY_A]: SPENT, [KEY_B]: SPENT })
  const { stream } = setup({ [REF_A]: KEY_A, [REF_B]: KEY_B, [ACTIVE]: KEY_A })
  let calls = 0
  const chunks = await collect(stream({ provider: 'opencode-go' }, () => {
    calls += 1
    return (async function* () { yield REFUSAL })()
  }))
  assert.equal(calls, 2, 'one refusal, one failover, then give up')
  assert.deepEqual(chunks, [REFUSAL])
}

// 6. Requests for other provider routes are returned untouched.
{
  const queries = stubUsage({ [KEY_A]: HEALTHY, [KEY_B]: HEALTHY })
  const { stream } = setup({ [REF_A]: KEY_A, [REF_B]: KEY_B })
  const own = (async function* () { yield SUCCESS })()
  assert.equal(stream({ provider: 'deepseek' }, () => own), own)
  assert.deepEqual(queries, [])
}

// 7. Misconfiguration fails activation with the offending field named.
{
  const fake = makeContext({})
  assert.throws(() => apply(fake.ctx, { route: 'opencode-go', activeRef: ACTIVE }), /`keys`/)
  assert.throws(() => apply(fake.ctx, { activeRef: ACTIVE, keys: [{ ref: REF_A }] }), /`route`/)
  assert.throws(() => apply(fake.ctx, { route: 'r', activeRef: ACTIVE, keys: [] }), /`keys`/)
}

// 8. The gateway's real refusal shape — accounting first, then the refusal —
//    leaves no trace: the refused attempt's usage chunk is dropped and the
//    retry streams exactly one accounting chunk of its own.
{
  stubUsage({ [KEY_A]: HEALTHY, [KEY_B]: HEALTHY })
  const { stream, store } = setup({ [REF_A]: KEY_A, [REF_B]: KEY_B, [ACTIVE]: KEY_A })
  const usageChunk = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  let calls = 0
  const chunks = await collect(stream({ provider: 'opencode-go' }, () => {
    calls += 1
    return (async function* () {
      yield usageChunk
      if (calls === 1) { yield REFUSAL; return }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield SUCCESS
    })()
  }))
  assert.equal(calls, 2, 'the refused request must be re-dispatched once')
  assert.deepEqual(chunks, [usageChunk, { type: 'text-delta', index: 0, text: 'ok' }, SUCCESS])
  assert.equal(store.get(ACTIVE), KEY_B)
}

console.log('dsh-opencode-go-pool selfcheck: 8 groups passed')
