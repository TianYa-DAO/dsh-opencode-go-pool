/**
 * Host half of dsh-opencode-go-pool.
 *
 * Keeps several OpenCode Go subscriptions (one API key each) behind the single
 * provider route the agent already uses. The route's `apiKeyEnv` points at a
 * pool-owned credential reference (`activeRef`); before each request for that
 * route this plugin installs the healthiest key into it, and when the gateway
 * refuses a request because a rolling/weekly/monthly window is exhausted it
 * cools that key for the window's reset time and re-dispatches the same frozen
 * request against the next key.
 *
 * Why the credential plane rather than the request: a loop-built request
 * arrives deep-frozen, so a `llm/stream` listener may read `options.provider`
 * but never rewrite it. The adapter resolves `apiKeyEnv` through the credential
 * seam on every request, which makes the reference the one mutable knob on the
 * path — and a knob whose worst case is a request served by a different but
 * still valid subscription.
 *
 * Health comes from the gateway's own usage endpoint,
 * `GET https://opencode.ai/zen/go/v1/usage`, which reports a `percent` and a
 * `status` per window ("rate-limited" once a window is spent).
 */

/** Plugin name shown by the loader. */
export const name = 'opencode-go-pool'

/** The pool reads the credential seam and hooks the model-request waterfall. */
export const inject = ['llm']

/** Gateway usage endpoint; the default matches the OpenCode Go plan. */
const DEFAULT_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
/** How long one usage reading is trusted before the pool refreshes it. */
const DEFAULT_USAGE_TTL_MS = 60_000
/** Floor for cooling a key the gateway throttled without naming a window. */
const DEFAULT_COOLDOWN_MS = 60_000
/** One usage query may not hold a request hostage longer than this. */
const USAGE_TIMEOUT_MS = 15_000
/** Failover re-dispatches allowed for one model call. */
const DEFAULT_MAX_FAILOVERS = 1

/**
 * Read and validate the entry configuration. Misconfiguration fails plugin
 * activation with the offending field named, rather than at the first request.
 * @param config - the entry's `config` value from the composed profile.
 * @returns the resolved pool configuration.
 */
function resolveConfig(config) {
  const raw = config ?? {}
  const route = requireName(raw.route, 'route')
  const activeRef = requireName(raw.activeRef, 'activeRef')
  if (!Array.isArray(raw.keys) || raw.keys.length === 0) {
    throw new Error('opencode-go-pool: `keys` must list at least one { ref, label } entry')
  }
  const keys = raw.keys.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`opencode-go-pool: keys[${index}] must be an object with a \`ref\``)
    }
    const ref = requireName(entry.ref, `keys[${index}].ref`)
    if (ref === activeRef) {
      throw new Error(
        `opencode-go-pool: keys[${index}].ref "${ref}" is the pool's own activeRef;`
        + ' store subscription keys under their own references',
      )
    }
    return { ref, label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : ref }
  })
  if (new Set(keys.map(key => key.ref)).size !== keys.length) {
    throw new Error('opencode-go-pool: `keys` lists the same credential reference twice')
  }
  return {
    route,
    activeRef,
    keys,
    usageUrl: typeof raw.usageUrl === 'string' && raw.usageUrl.length > 0 ? raw.usageUrl : DEFAULT_USAGE_URL,
    usageTtlMs: positiveNumber(raw.usageTtlMs, DEFAULT_USAGE_TTL_MS, 'usageTtlMs'),
    cooldownMs: positiveNumber(raw.cooldownMs, DEFAULT_COOLDOWN_MS, 'cooldownMs'),
    maxFailovers: nonNegativeInteger(raw.maxFailovers, DEFAULT_MAX_FAILOVERS, 'maxFailovers'),
  }
}

/**
 * Accept a non-empty credential reference name.
 * @param value - the configured value.
 * @param field - field name to name in the failure.
 * @returns the same string.
 */
function requireName(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`opencode-go-pool: \`${field}\` must be a non-empty credential reference name`)
  }
  return value
}

/**
 * Accept a positive number or fall back to the shipped default.
 * @param value - the configured value.
 * @param fallback - value used when absent.
 * @param field - field name to name in the failure.
 * @returns the resolved number.
 */
function positiveNumber(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`opencode-go-pool: \`${field}\` must be a positive number`)
  }
  return value
}

/**
 * Accept a non-negative integer or fall back to the shipped default.
 * @param value - the configured value.
 * @param fallback - value used when absent.
 * @param field - field name to name in the failure.
 * @returns the resolved integer.
 */
function nonNegativeInteger(value, fallback, field) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`opencode-go-pool: \`${field}\` must be a non-negative integer`)
  }
  return value
}

/**
 * Recognize the failure the pool reacts to: a spent quota window or a plain
 * throttle. The gateway answers a spent window with HTTP 429 and
 * `{"error":{"type":"GoUsageLimitError"}}`; the harness classifies that text as
 * `QUOTA` (or `RATE_LIMIT` when only the status survives), and both are retried
 * here because `QUOTA` is not in the default retryable-code set.
 * @param failure - the failure carried by a terminal error finish chunk.
 * @returns whether the pool should cool the served key and fail over.
 */
function isThrottleFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false
  const code = String(failure.code ?? '')
  if (code === 'QUOTA' || code === 'RATE_LIMIT') return true
  if (failure.status === 429) return true
  return /\b429\b|rate.?limit|usage[\s_-]+limit|quota|insufficient[\s_-]+(?:quota|balance|credits?)/i
    .test(String(failure.message ?? ''))
}

/**
 * Install the pool into the harness context.
 * @param ctx - the plugin's Cordis context.
 * @param config - the entry's `config` value.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  /** Latest usage reading per credential reference. */
  const usage = new Map()
  /** Timestamp until which a reference stays out of rotation after a refusal. */
  const cooldown = new Map()
  /** In-flight usage queries, so concurrent requests share one. */
  const inFlight = new Map()
  /** Tail of the decision queue; see {@link serialize}. */
  let decisions = Promise.resolve()

  /**
   * Run one pool decision at a time. Two decisions overlapping would each read
   * a state the other is about to change — a request and the activation warm-up
   * race on the very first use — and could install different keys in sequence.
   * @param task - the decision to run.
   * @returns the task's own result.
   */
  function serialize(task) {
    const run = decisions.then(task, task)
    decisions = run.then(() => undefined, () => undefined)
    return run
  }

  const log = (level, message) => {
    const logger = ctx.logger
    if (logger === undefined) return
    if (typeof logger[level] === 'function') logger[level](`opencode-go-pool: ${message}`)
  }

  /** The credential seam; read per call because activation order is not fixed. */
  const credentials = () => ctx.get('credentials')

  /**
   * Resolve one credential reference to its stored value.
   * @param ref - credential reference name.
   * @returns the value, or undefined while the reference is unset.
   */
  async function valueOf(ref) {
    const seam = credentials()
    if (seam === undefined) return undefined
    const resolved = await seam.resolve(ref)
    const value = resolved?.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /**
   * Query the gateway's usage endpoint for one key.
   * @param value - the API key to interrogate.
   * @returns the parsed windows, or undefined when the query failed.
   */
  async function queryUsage(value) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS)
    try {
      const response = await fetch(settings.usageUrl, {
        headers: { Authorization: `Bearer ${value}` },
        signal: controller.signal,
      })
      if (!response.ok) return undefined
      const body = await response.json()
      const windows = body?.usage
      if (windows === null || typeof windows !== 'object') return undefined
      let throttled = false
      let pressure = 0
      let resetAt = 0
      for (const key of ['rolling', 'weekly', 'monthly']) {
        const window = windows[key]
        if (window === null || typeof window !== 'object') continue
        const percent = typeof window.percent === 'number' && Number.isFinite(window.percent)
          ? window.percent
          : 0
        pressure = Math.max(pressure, percent)
        const spent = window.status === 'rate-limited' || percent >= 100
        if (!spent) continue
        throttled = true
        const reset = Date.parse(String(window.resetsAt ?? ''))
        if (Number.isFinite(reset)) resetAt = Math.max(resetAt, reset)
      }
      return { throttled, pressure, resetAt, at: Date.now() }
    } catch (error) {
      // A usage query is advisory: a failed one leaves the previous reading in
      // place and never blocks or fails the model request.
      if (error?.name !== 'AbortError') log('warn', `usage query failed: ${String(error?.message ?? error)}`)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Refresh one reference's usage reading, sharing concurrent queries.
   * @param key - the pool entry to refresh.
   * @returns the reading, or undefined when unavailable.
   */
  function refreshUsage(key) {
    const pending = inFlight.get(key.ref)
    if (pending !== undefined) return pending
    const query = (async () => {
      const value = await valueOf(key.ref)
      if (value === undefined) return undefined
      const reading = await queryUsage(value)
      if (reading !== undefined) usage.set(key.ref, reading)
      return reading
    })().finally(() => inFlight.delete(key.ref))
    inFlight.set(key.ref, query)
    return query
  }

  /**
   * Refresh a reference's reading unless a fresh one is already held.
   * @param key - the pool entry.
   * @returns the reading, or undefined when unavailable.
   */
  function ensureUsage(key) {
    const reading = usage.get(key.ref)
    if (reading !== undefined && Date.now() - reading.at <= settings.usageTtlMs) {
      return Promise.resolve(reading)
    }
    return refreshUsage(key)
  }

  /**
   * Describe every pool entry.
   * @returns one state row per configured key.
   */
  async function describeAll() {
    const rows = []
    for (const key of settings.keys) rows.push(await describe(key))
    return rows
  }

  /**
   * Describe one pool entry's current state.
   * @param key - the pool entry.
   * @returns its stored value and rotation state.
   */
  async function describe(key) {
    const value = await valueOf(key.ref)
    const reading = usage.get(key.ref)
    const cooledUntil = cooldown.get(key.ref) ?? 0
    return {
      key,
      value,
      hasReading: reading !== undefined,
      throttled: reading?.throttled === true,
      pressure: reading?.pressure ?? 0,
      resetAt: reading?.resetAt ?? 0,
      cooling: cooledUntil > Date.now(),
      horizon: Math.max(reading?.resetAt ?? 0, cooledUntil),
      fresh: reading !== undefined && Date.now() - reading.at <= settings.usageTtlMs,
    }
  }

  /**
   * Pick the entry a request should use.
   * @param rows - every entry with its current state.
   * @param excludeRef - reference to avoid (the one that just failed).
   * @returns the chosen row, preferring the lowest pressure among healthy ones.
   */
  function choose(rows, excludeRef) {
    // A key with no reading is not a healthy key: it is an unknown one, and
    // treating it as healthy is exactly how a spent subscription reaches the
    // wire. Unknown keys stay out of the preferred set and are only reached
    // when nothing better exists.
    const usable = rows.filter(row => row.value !== undefined && row.hasReading
      && !row.throttled && !row.cooling)
    if (usable.length > 0) return usable.toSorted((a, b) => a.pressure - b.pressure)[0]
    const excluded = rows.filter(row => row.value !== undefined && row.key.ref !== excludeRef)
    const candidates = excluded.length > 0 ? excluded : rows.filter(row => row.value !== undefined)
    if (candidates.length === 0) return undefined
    // Every key is spent, cooling, or unknown: take the one that recovers
    // first, so a request still goes somewhere and the next attempt has a
    // better chance.
    return candidates.toSorted((a, b) => a.horizon - b.horizon)[0]
  }

  /**
   * Install one key into the route's reference.
   * @param row - the chosen entry.
   * @returns whether the reference now holds that key.
   */
  async function install(row) {
    const seam = credentials()
    if (seam === undefined) return false
    await seam.set(settings.activeRef, row.value)
    return true
  }

  /**
   * Make sure the route's reference holds a key worth trying.
   *
   * A reading the pool has never taken is awaited, because without it a spent
   * subscription is indistinguishable from a healthy one and guessing costs a
   * refused request; readings merely past their TTL refresh in the background
   * instead, so steady-state requests are never delayed by a usage query. The
   * snapshot is re-taken after awaiting, because the readings that landed while
   * it was being built would otherwise leave rows described at different
   * moments — a torn snapshot in which a spent key looks untouched.
   * @returns the entry the reference should hold for the next request.
   */
  function ensureActive() {
    return serialize(ensureActiveOnce)
  }

  /**
   * One serialized activation decision; see {@link ensureActive}.
   * @returns the entry the reference should hold for the next request.
   */
  async function ensureActiveOnce() {
    let rows = await describeAll()
    if (rows.some(row => row.value !== undefined && !row.hasReading)) {
      await Promise.all(settings.keys.map(key => ensureUsage(key)))
      rows = await describeAll()
    } else {
      for (const row of rows) {
        if (row.value !== undefined && !row.fresh) void ensureUsage(row.key)
      }
    }

    const currentValue = await valueOf(settings.activeRef)
    const current = rows.find(row => row.value !== undefined && row.value === currentValue)
    if (current === undefined) {
      const chosen = choose(rows)
      if (chosen === undefined) return undefined
      await install(chosen)
      log('info', `installed ${chosen.key.label} as the active key`)
      return chosen
    }
    if (current.throttled || current.cooling) {
      const chosen = choose(rows, current.key.ref)
      // Only a usable key justifies rewriting the reference: rotating between
      // two spent subscriptions would churn the credential document and hide
      // the fact that the pool has nowhere good left to go.
      if (chosen !== undefined && chosen.key.ref !== current.key.ref
        && !chosen.throttled && !chosen.cooling) {
        await install(chosen)
        log('info', `switched away from ${current.key.label}${reasonOf(current)} to ${chosen.key.label}`)
        return chosen
      }
      log('warn', `${current.key.label} is out of quota and no other key can serve the request`)
    }
    return current
  }

  /**
   * Render why a key stepped aside.
   * @param row - the described entry.
   * @returns a suffix for the switch log line.
   */
  function reasonOf(row) {
    if (row.throttled) {
      return row.resetAt > 0 ? ` (quota spent, resets ${new Date(row.resetAt).toISOString()})` : ' (quota spent)'
    }
    return ' (cooling down)'
  }

  /**
   * Cool the key this attempt was served by and install another one.
   *
   * The failed key is the one the attempt expected, not whatever the reference
   * holds now: concurrent requests for the same route share one reference, so a
   * sibling request may have installed a different key while this attempt was in
   * flight. Cooling the value the reference happens to hold would blame the
   * wrong subscription and rotate away from a healthy key.
   * @param failure - the terminal failure observed on the stream.
   * @param failed - the entry this attempt was served by.
   * @returns the entry now installed, or undefined when the pool cannot move on.
   */
  function failover(failure, failed) {
    return serialize(() => failoverOnce(failure, failed))
  }

  /**
   * One serialized failover decision; see {@link failover}.
   * @param failure - the terminal failure observed on the stream.
   * @param failed - the entry this attempt was served by.
   * @returns the entry now installed, or undefined when the pool cannot move on.
   */
  async function failoverOnce(failure, failed) {
    if (failed === undefined) return undefined
    const reading = await refreshUsage(failed.key) ?? usage.get(failed.key.ref)
    const floor = Date.now() + settings.cooldownMs
    const retryAfterMs = typeof failure?.providerRetryAfterMs === 'number' ? failure.providerRetryAfterMs : 0
    const until = Math.max(floor, reading?.resetAt ?? 0, Date.now() + retryAfterMs)
    cooldown.set(failed.key.ref, until)
    if (reading !== undefined) usage.set(failed.key.ref, reading)

    const fresh = await describeAll()
    const failedRow = fresh.find(row => row.key.ref === failed.key.ref) ?? failed
    const chosen = choose(fresh, failed.key.ref)
    if (chosen === undefined || chosen.key.ref === failed.key.ref) {
      log('warn', `${failed.key.label} refused the request and no other key is available`)
      return undefined
    }
    await install(chosen)
    const limit = failure?.message === undefined ? '' : ` — ${String(failure.message)}`
    log('info', `failover ${failed.key.label}${reasonOf(failedRow)}`
      + ` -> ${chosen.key.label} (until ${new Date(until).toISOString()})${limit}`)
    return chosen
  }

  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== settings.route) return next()
    return (async function* pooledStream() {
      let served = await ensureActive()
      for (let attempt = 0; ; attempt++) {
        // Chunks a retry would repeat. `usage` is accounting rather than model
        // output — the adapter emits one before reporting a refused request —
        // so it is held back until the attempt commits; anything else commits
        // immediately, because a block the consumer has already seen must not
        // be replayed by a second attempt.
        let held = []
        let committed = false
        let terminal
        for await (const chunk of next()) {
          if (chunk?.type === 'finish') {
            terminal = chunk
            break
          }
          if (!committed && chunk?.type === 'usage') {
            held.push(chunk)
            continue
          }
          if (!committed) {
            committed = true
            for (const pending of held) yield pending
            held = []
          }
          yield chunk
        }
        const failure = terminal?.reason?.kind === 'error' ? terminal.reason.failure : undefined
        // A refusal leaves the request indistinguishable from one never sent
        // (no token, no tool call), so re-dispatching it cannot duplicate
        // model output; a failure after partial output is surfaced instead.
        const switchable = failure !== undefined
          && served !== undefined
          && !committed
          && !options.signal?.aborted
          && attempt < settings.maxFailovers
          && isThrottleFailure(failure)
        if (switchable) {
          const next2 = await failover(failure, served)
          if (next2 !== undefined) {
            served = next2
            continue
          }
        }
        for (const pending of held) yield pending
        if (terminal !== undefined) yield terminal
        return
      }
    })()
  })

  ctx.on('dispose', () => {
    inFlight.clear()
    usage.clear()
    cooldown.clear()
  })

  log('info', `pooling ${settings.keys.map(key => key.label).join(', ')}`
    + ` behind route "${settings.route}" through ${settings.activeRef}`)

  // Warm the readings at activation so the first request of a session already
  // sees which subscriptions are spent. Startup work, so it neither delays nor
  // fails anything: an unreachable usage endpoint leaves the pool on its
  // refusal-driven path.
  void (async () => {
    try {
      await Promise.all(settings.keys.map(key => ensureUsage(key)))
      await ensureActive()
    } catch (error) {
      log('warn', `warm-up failed: ${String(error?.message ?? error)}`)
    }
  })()
}
