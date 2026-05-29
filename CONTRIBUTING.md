# Contributing

## Workflow

1. Branch from `main` with a conventional prefix: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`.
2. Run `task ci` locally before pushing. CI must pass.
3. Use the structured commit-message format from `~/.claude/CLAUDE.md` (section headers, file-level detail, scaled verbosity).
4. Open a PR. Reviews are required for changes under `src/connectors/`, `src/oauth/`, `packages/oauth/`, and `chart/`.

## Local prereqs

| Tool     | Version                           |
| -------- | --------------------------------- |
| `node`   | see `package.json` engines (≥ 24) |
| `npm`    | bundled with Node 24              |
| `helm`   | matches the target cluster minor  |
| `task`   | latest                            |
| `docker` | for the container build job       |

## Layout

See [README.md](./README.md), [AGENTS.md](./AGENTS.md), and [ARCHITECTURE.md](./ARCHITECTURE.md).

## The test contract (grep-enforced in CI)

Three invariants are enforced by CI grep checks — they are the load-bearing guardrails of a
per-user-ACL system, not style preferences:

1. **Never `vi.mock(<sdk-package>)`.** Every cross-boundary service is a `createXxx(deps)`
   factory taking typed ports; inject fakes on the source side. AWS SDK clients use
   `aws-sdk-client-mock` (client-level), never module-level mocking.
2. **No bare `fetch(`** outside the whitelist (`src/index.ts`, `src/connectors/`,
   `src/identity/workos-resolver.ts`, `src/oauth/`, or a `// allow-fetch` line). Boundary
   calls take an injected `fetchImpl` so tests pass `vi.fn<typeof fetch>()`.
3. **No `new WebClient(`** outside the whitelist (`src/index.ts`, `src/slack/`). The Slack
   client is constructed once at the bootstrap and injected downstream.

Coverage thresholds are enforced at **75 / 60 / 75 / 75** (statements / branches / functions
/ lines). New boundary code needs a port-injected test; new pure logic needs a direct test.

## Adding a connector

1. Add a `ConnectorVerifier` in `src/connectors/<source>.ts` — a probe that takes the injected
   `fetchImpl` and a `getAccessToken` callback and returns access/no-access **fail-secure**
   (missing token, 403, 404, timeout, network error → redacted).
2. Register it in the connector registry and add the source to the `SUPPORTED_SOURCES` tuple.
3. Wrap it in its own circuit breaker (`failureThreshold: 5`, `windowMs: 60s`,
   `halfOpenAfterMs: 30s`) and emit `circuit_open_total{source}` on trip.
4. Add an `acl-guard` test covering grant / 403 / 404 / missing-token / network-error /
   breaker-trip with a `vi.fn<typeof fetch>()` fake — no SDK mocking.

## Adding an OAuth provider

1. Add a provider adapter in `packages/oauth/` (the `almanac-oauth` module) and register it.
2. Wire it through `src/oauth/router.ts`.
3. Add the provider's `*_OAUTH_*` env vars to the Zod config schema and `.env.example`.
4. Cover the signed-`/start`-URL round-trip in `src/oauth/url-token.test.ts`.

## Deploy contract

This app ships as a Platform tenant: a Helm `chart/`, a `platform.yaml` (Platform +
BudgetPolicy CRs), and a `gitops/applicationset-entry.yaml`. Per-tenant AWS substrate lives
in `landing-zone` (the `almanac-platform` component); cluster addons live in `eks-gitops`. Do
not add IAM, cloud resources, or cluster addons to the chart — see
[ARCHITECTURE.md](./ARCHITECTURE.md#boundaries).

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
