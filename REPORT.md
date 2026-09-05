# Findings that belong to other repositories

Written from `nanohype/slack-knowledge-bot`, branch `crd-freshness`, while closing the
stale-freshness-instruction item here. Nothing below is edited in this repository.

## 1. `library/scripts/sync-vendored.mjs` in `nanohype/nanohype` — the same defect, stronger

`scripts/sync-vendored.mjs` here is a byte-identical vendored copy of
`library/scripts/sync-vendored.mjs` upstream, declared in `scripts/vendored.json` and
enforced by `npm run sync:vendored:check`. Editing it in this repository turns the required
`verify` job red, so the fix belongs upstream and every repository that vendors the library
carries the defect until it lands there.

Its freshness report (`runFreshness`) emits, when the pin is behind:

```
  ✗ the pin <pin12> is behind nanohype/nanohype@<tip12>:
      <path> — changed upstream since the pin

    Nothing is broken — the vendored copies still match the commit they claim.
    Adopt the newer library when convenient: `npm run sync:vendored -- --ref=<tip40>`,
    review the diff, and ship it with whatever change it implies.
```

`<tip40>` is `git rev-parse HEAD` of the upstream checkout, resolved during the run and
printed as a full 40-character SHA — the portal-#221 defect exactly, and worse than the CRD
report's, which named an unfollowable `<sha>` placeholder rather than a wrong commit. A
reader acting on it re-vendors to whatever was newest when the scheduled job last ran.

The fix mirrors what landed here on `scripts/sync-crd-schemas.mjs`:

- `--ref=latest` resolving upstream when the re-vendor runs. For this script the natural
  resolution is `git log -1 --format=%H HEAD -- <every entry.src>` — the newest commit
  touching any vendored path. Filtering to the paths rather than taking the branch tip is
  what makes a re-vendor idempotent and makes the following freshness run report current.
- The report naming that command and no commit.
- `--ref` accepting `latest` — `isSha` rejects everything but 40 hex characters, so
  `--ref=latest` fails before it resolves anything.
- Refusing a clone that cannot answer for upstream. `runFreshness` reads
  `git rev-parse HEAD` of `$NANOHYPE_DIR` with no check that the clone is unshallow or that
  the pin precedes what it resolves, so it carries both hazards described under portal
  below — and more sharply, because `latest` there would resolve across every vendored
  path at once.

`scripts/freshness-report-test.mjs` here is written as a table over reports for this reason:
adopting the fixed library adds a row rather than a second harness.

### A second, independent defect in the same function

`runFreshness` returns `1` for "the pin is behind". `sync-crd-schemas.mjs` returns `2`, and
`.github/workflows/crd-schema-freshness.yml` depends on that distinction — it files a drift
issue on 2 and fails the job on anything else, so a month of failed lookups cannot read as a
month of confirmed drift. The vendored script collapses both into 1.

It does not bite today only because `.github/workflows/vendored-freshness.yml` files no
issue and treats any non-zero as red. Any repository that wires the library's freshness
report to an issue inherits the collapse.

## 2. `nanohype/portal` — gaps in the reference gate (`scripts/freshness_test.sh`, merged as 6b08635)

Reported as evidence, not as a request; portal's shape is its own.

**Its structural refusal only covers full 40-character ids.** The assertion is
`grep -qE '[0-9a-f]{40}' <<<"${out//$stale/}"`. A report printing `${head:0:12}` — the shape
this repository's CRD report actually had, in its verdict header and in every per-file line —
passes that grep untouched. `git rev-parse` accepts seven characters, so that is where the
floor belongs; a stale instruction does not become correct by being abbreviated. The gate
here names the commits its fixture built and looks for any of them from seven characters up,
and separately rejects any hex run of seven or more that carries a digit, whichever commit it
belongs to. The digit is what separates a sha from a word: `defaced` and `acceded` are seven
hex characters, and a seven-character sha is all-letters about once in a thousand. The mutant
`the verdict line carries the resolved commit, abbreviated` is exactly this case.

It is also case-sensitive, and `git cat-file -e` accepts an uppercase sha like any other, so
an id printed in upper case is one a reader can act on.

**Its fixture cannot distinguish "the branch tip" from "the newest commit touching the
vendored path".** `upstream()` builds two commits, both touching the vendored path, so
`git rev-parse HEAD` and `git log -1 -- <path>` return the same sha and either resolver
satisfies `sync latest resolves to upstream HEAD`. A resolver reading the branch tip pins to
an unrelated commit whenever anything else lands upstream first — which is the common case.
The fixture here adds a commit touching a file outside the vendored path, so the two
resolutions differ by construction; the mutant
`` `latest` resolves the branch tip rather than the vendored path's newest commit`` fails
against it and would pass against portal's.

**It drives one seam.** `run_case` sets `EKS_AGENT_PLATFORM_DIR` on every invocation, so
every assertion and every mutant exercises the checkout branch of `upstream_head` and
`fetch`. The GitHub branch beside it — the one a scheduled runner with no checkout takes —
is never executed, so the fix can be removed there with the gate staying green. The gate
here runs both, the second through a `--import` stub answering api.github.com and
raw.githubusercontent.com out of the same fixture repository, and writes a per-seam mutant
wherever the two reach upstream differently (a git argument on one, a query parameter on the
other) — a single mutant is a no-op on the seam it does not name, and reports the fix present
there on that evidence.

**`upstream_head` trusts whatever clone it is given.** `git log -1 --format=%H -- <path>`
against `$EKS_AGENT_PLATFORM_DIR` is anchored to that clone's HEAD, with no check that the
clone can answer for upstream. Two shapes give a confident wrong answer rather than an error,
and both are what an operator following the remediation has lying around:

- A shallow clone. `git log` treats the shallow boundary as parentless, so every path reads
  as introduced there and the newest commit touching any path is HEAD. Against a depth-1
  clone at the pin — the shape CI already builds for the blocking check — that resolves the
  pin, and the report finds the pin current against itself. A silent "no drift".
- A clone that does not descend from the pin (un-fetched, detached, on a feature branch).
  `latest` then names a commit older than what is already vendored, so following the
  remediation **reverts** the schemas, and the byte comparison cannot tell "differs" from
  "is behind" so it reported drift on the way in. The subsequent blocking check passes —
  pin, bytes and digests are mutually consistent — and the next freshness run reports
  current, which is what closes the drift issue. The instruction undoes its own subject and
  dismisses its own warning, which is the defect this PR set out to remove, arrived at from
  the other side.

Both are refused here, and both refusals carry a mutant.

**Its remediation assertion is one-sided.** `grep -q -- "-- latest"` passes on a report that
names the command AND an unfollowable `<sha>` placeholder beside it; the reader still has to
resolve a commit, and the nearest one in view is whatever the last run printed. Portal
guards its issue body against that shape but not its report. Both are guarded here.

## 3. Not covered anywhere, and worth carrying to any repository with this shape

The freshness report is not the only prose a reader sees. The scheduled workflow writes a
remediation block of its own beside it — `.github/workflows/crd-schema-freshness.yml` said
`npm run schemas:sync -- --ref=<sha>` in YAML, where no assertion on the script could reach
it. Portal edited its equivalent block by hand in the same PR and left it ungated, so a
later edit can put the placeholder back with `scripts/freshness_test.sh` still green.

The gate here reads that heredoc out of the workflow file and asserts on it, and two of its
mutants target it. Any repository whose scheduled job composes an issue body around a report
has the same second surface.
