# Vendored operator CRD schemas

The `Tenant`, `Platform`, and `BudgetPolicy` CustomResourceDefinitions from
[`nanohype/eks-agent-platform`](https://github.com/nanohype/eks-agent-platform),
`operators/config/crd/bases/` — controller-gen output, copied byte for byte.
`scripts/validate-platform-manifests.mjs` validates `platform.yaml` against
these files, so they are the gate's ground truth.

**Never hand-edit them.** Fix the API types upstream, regenerate there, then
re-vendor here.

## source.json

`source.json` records where the copies came from — `upstream.repository`,
`upstream.path`, the pinned `upstream.ref` — plus a SHA-256 per file. The two
pins do different jobs:

- **`upstream.ref`** makes the gate deterministic. The schema CI validates
  against today is the schema it validated against yesterday; adopting a newer
  operator API is an explicit commit that moves the SHA. It must be a full
  40-character commit SHA: a branch name would make the verdict depend on when
  the gate ran.
- **`sha256`** makes the copies tamper-evident with no network. The validator
  hashes every file against its record before parsing it, so editing a vendored
  schema to admit the manifest under review — widening an enum, dropping a
  `required` entry — aborts the run.

Neither check subsumes the other, and each covers the other's blind spot:

| | edited copy, digest not updated | edited copy, digest updated to match | pin no longer describes the copies |
| --- | --- | --- | --- |
| `npm run platform:validate` (offline) | fails | passes | passes |
| `npm run schemas:check` (upstream at the pinned ref) | fails | **fails** | **fails** |

Both run in CI, and both fail loudly: an unreachable upstream, a missing file,
undeclared YAML in this directory, or a checkout whose HEAD is not the pinned
commit exits non-zero rather than skipping.

## Pin fidelity, not freshness

`schemas:check` asks one question: do the vendored bytes equal upstream **at the
pinned ref**? That answer depends only on the commit under test, which is what a
blocking gate needs — a required check that turns red because someone pushed to
another repository is not reproducible, and teaches people to re-run CI instead
of reading it.

Whether the pin has fallen behind upstream is a real question with a different
shape: its answer changes on someone else's schedule, and nothing is broken when
it comes back "behind" — the copies still match the commit they claim.
`npm run schemas:freshness` answers it, and the `crd-schema-freshness` workflow
runs it weekly (and on demand). It is never wired into pull-request CI.

## Commands

```bash
npm run platform:validate   # the gate: digests, then platform.yaml, then a self-test
npm run schemas:sync        # re-vendor the copies + digests from the pinned ref
npm run schemas:check       # blocking drift gate: copies vs upstream at the pinned ref
npm run schemas:freshness   # scheduled-only: has the pin fallen behind upstream?
npm run schemas:freshness:test  # assert that report names a command, not a commit
```

Upstream resolves two ways, both deterministic, and both read AT A REF rather
than from a working tree: `git show <ref>:<path>` against a checkout named by
`$EKS_AGENT_PLATFORM_DIR`, or raw.githubusercontent.com at that same ref. Under
`--check` the checkout's HEAD must also be the pinned commit, because CI checks
that SHA out and a job wired to a different one would be a verdict about
something other than the pin. An unreachable upstream is a failure, never a skip.

## Adopting a newer operator API

1. `npm run schemas:sync -- --ref=latest` — resolves the newest commit touching
   `operators/config/crd/bases`, then moves the pin and rewrites the copies and
   their digests in one step, so the two cannot drift apart. A full 40-character
   SHA works too, when the target is a specific commit rather than the newest.

   `latest` is what `npm run schemas:freshness` names. That report is copied
   verbatim into an issue body re-edited weekly and read on whatever day someone
   opens it, so a commit resolved during one run and printed there is the newest
   thing upstream for at most a week while being presented as current for as
   long as the issue stays open — following it re-vendors to the wrong ref and
   closes an issue that should have stayed open.

   `scripts/freshness-report-test.mjs` runs the report against a fixture upstream
   repository and asserts on its bytes: none of the commits that fixture built
   appearing at seven characters or more, no hex run of seven or more carrying a
   digit whatever commit it belongs to, a remediation naming the command with no
   placeholder beside it, and that command landing the pin on the fixture's
   newest commit touching the vendored path. It drives both seams — the checkout,
   and GitHub through a fetch stub serving the same fixture — because the
   scheduled workflow reads only the second. `--self-test` removes the fix every
   way it can come back and fails unless the assertion named for each break is
   what catches it.

   `latest` refuses a clone that cannot answer for upstream: a shallow one, where
   every path reads as introduced at the boundary so the pin is current against
   itself, and one that does not descend from the pin, where `latest` would name
   something older than what is already vendored.
2. `npm run platform:validate` — a CRD change that invalidates `platform.yaml`
   surfaces here, before a cluster sees it.
3. Commit the schema diff, the pin move, and any manifest changes together.
