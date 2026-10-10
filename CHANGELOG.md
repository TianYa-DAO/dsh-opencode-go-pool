# Changelog

## [0.1.0] - 2026-10-10

Initial release.

1. Pools several OpenCode Go subscriptions (one API key each) behind one provider route by writing the effective key into a plugin-owned credential reference before each request, because a loop-built request is deep-frozen and only `apiKeyEnv` is resolved again per request.
2. Reads the gateway's own usage endpoint for the 5-hour, weekly and monthly windows, never puts a spent key on the wire, and refreshes a merely stale reading in the background instead of blocking the request.
3. On `HTTP 429` + `GoUsageLimitError` it cools that key for the `Retry-After` or the window reset and re-dispatches the same frozen request against the next key — only while the request has produced no token yet.
4. Misconfiguration (a `keys[].ref` equal to `activeRef`, a missing field, a rejected usage payload) fails loud at activation or at the earliest resolvable point, naming the offending field.
5. Self-check harness over the real plugin code with a fake context and a fake usage endpoint, covering eight behavior groups.
