# dsh-opencode-go-pool

> **Found a bug or have a suggestion?** Open an [issue](https://github.com/TianYa-DAO/dsh-opencode-go-pool/issues), or email [2842425998@qq.com](mailto:2842425998@qq.com).

Pools several **OpenCode Go** subscriptions (one API key each) behind the single provider route the agent already uses: before each request it installs the healthiest key, cools a key the gateway refuses until that window resets, and re-dispatches against the next one — with no manual model switching.

English | [中文](README.md)

## Why switch credentials, not routes

The model requests the DSH agent loop builds are deep-frozen (`options` cannot be modified; touching it throws), so a waterfall listener may read `options.provider` but can never rewrite it. What *is* resolved again on every request is the provider's `apiKeyEnv` credential reference — so this plugin points the route at an `activeRef` it owns, and writes the currently healthy subscription key into that reference before each request.

## How it works

1. Each subscription key lives in the standard credential store (`$DSH_HOME/.credentials.yaml`, manageable from the settings page); the plugin only reads it by reference name.
2. The route's `apiKeyEnv` points at `activeRef` (for example `OPENCODE_GO_ACTIVE_KEY`), a reference the plugin writes exclusively.
3. The plugin calls the gateway's own usage endpoint, `GET https://opencode.ai/zen/go/v1/usage` (plain API key, no org token), and reads `percent` and `status` for the 5-hour, weekly and monthly windows; `status: "rate-limited"` or `percent >= 100` means that window is spent.
4. Before each request: when a reading is missing it **checks once first** (not knowing could put a spent key on the wire); when a reading is merely stale it **refreshes in the background** without blocking the request; when the active key is spent it switches to the healthiest one immediately.
5. When the gateway rejects with `HTTP 429` + `{"error":{"type":"GoUsageLimitError"}}` + `Retry-After` (the Harness classifies this as `QUOTA`, which is **not** in the default retry codes, so the plugin re-dispatches it itself), it cools that key for the `Retry-After` or the window reset and **re-sends the same request once** against another key — but only while **the request has produced no token yet**. Once output exists it reports the error honestly instead of generating twice.

Decision points that can overlap (activation warm-up and concurrent requests) run serialized, so two state snapshots never interleave.

## Configuration

The plugin itself is one `insert` row (see `cordis.patch.yml`); the real configuration belongs in your profile patch layer:

```yaml
- insert:
    - id: opencode-go-pool
      name: 'dsh-opencode-go-pool'
- id: opencode-go-pool
  config:
    route: opencode-go                 # the provider route to take over
    activeRef: OPENCODE_GO_ACTIVE_KEY  # credential reference this plugin writes exclusively
    keys:
      - { ref: OPENCODE_GO_API_KEY, label: 订阅A }
      - { ref: OPENCODE_GO_API_KEY_B, label: 订阅B }
```

Point that route's `apiKeyEnv` at `activeRef` as well:

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_ACTIVE_KEY
        api: openai-completions
        baseURL: https://opencode.ai/zen/go/v1
```

Optional fields and defaults: `usageUrl` (defaults to the usage endpoint above), `usageTtlMs` (60000), `cooldownMs` (60000, the cooldown floor when the gateway names no window), `maxFailovers` (1, how many switches one call may make).

`keys[].ref` must differ from `activeRef`; a misconfiguration fails at activation and names the offending field.

## Observable behavior

Logs (prefixed `opencode-go-pool:`, through the Host logger):

1. `pooling 订阅A, 订阅B behind route "opencode-go" through OPENCODE_GO_ACTIVE_KEY` — loaded.
2. `installed 订阅B as the active key` — first fill, or a first switch.
3. `switched away from 订阅A (quota spent, resets …) to 订阅B` — a spent key avoided before the request.
4. `failover 订阅A (quota spent, resets …) -> 订阅B (until …) — Go usage limit exceeded` — rejected, switched, re-dispatched.

## Local integration (desktop profile)

1. The plugin source is `~/.dsh/plugins/dsh-opencode-go-pool`; the profile takes it through a `file:../../plugins/dsh-opencode-go-pool` dependency plus the `insert` row in `cordis.patch.yml`.
2. Credentials: `OPENCODE_GO_API_KEY` (subscription A), `OPENCODE_GO_API_KEY_B` (subscription B), `OPENCODE_GO_ACTIVE_KEY` (the effective key, written only by the plugin).
3. Both the `opencode-go` and `opencode-go-responses` routes of `llm-pi-ai` point at `OPENCODE_GO_ACTIVE_KEY`.
4. The profile uses `nodeLinker: hoisted`, so `file:` dependencies land as **hard links**: editing `index.js` takes effect in the profile immediately; if an editor replaces the file (new inode), run `pnpm install` in the profile directory to rebuild the link. Applying a change still needs a desktop restart.
5. Real-path regression overlays: `tests/e2e-overlay.yml` (usage-driven switching) and `tests/e2e-overlay-failover.yml` (429-driven switching, with `usageUrl` pointed at an unreachable port).

## Tests

```sh
node tests/selfcheck.mjs
```

Runs the real plugin code against a fake context and a fake usage endpoint, covering eight behavior groups: a spent key never reaches the wire, an already-installed healthy key is not rewritten, a rejected request is taken over and re-dispatched, no re-dispatch once output exists, budget-bounded convergence when every key is spent, pass-through for requests to other routes, misconfiguration reporting, and the rejected attempt's accounting block not leaking.

## Limitations

1. Health is judged before a request and **after** a rejection; exhaustion is never predicted.
2. Per-request decisions apply only to the route named by `route`; other routes pointing at the same `activeRef` merely inherit the effective key.
3. Switching is a transport-layer routing decision and writes no session event; its evidence lives in the Host log, not in the session record.

## License

[MIT](LICENSE)
