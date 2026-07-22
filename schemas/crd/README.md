# Vendored CRD schemas

Byte-identical copies of the `controller-gen` output in
[`nanohype/eks-agent-platform`](https://github.com/nanohype/eks-agent-platform)
under `operators/config/crd/bases/`. They are the schemas
`scripts/validate-platform-manifests.mjs` checks `platform.yaml` against.

| File                                          | Kind           | Scope      |
| --------------------------------------------- | -------------- | ---------- |
| `platform.nanohype.dev_tenants.yaml`           | `Tenant`       | Cluster    |
| `platform.nanohype.dev_platforms.yaml`         | `Platform`     | Namespaced |
| `governance.nanohype.dev_budgetpolicies.yaml`  | `BudgetPolicy` | Namespaced |

`source.json` records the upstream repository, the path, the commit the copies
were taken from, and a SHA-256 per file.

## Why vendored rather than fetched

The validator runs on every pull request, including from forks. Fetching the
schema at gate time makes the verdict depend on a third party being reachable,
and the tempting failure handler — skip validation when the fetch fails — is
the exact shape of bug this gate exists to catch. Reading the schema out of the
working tree makes the result a pure function of the commit under test.

## The two ways a vendored copy can lie, and what catches each

**Edited in place.** A widened enum or a dropped `required` entry leaves the
file valid YAML and leaves the gate happily validating against a weaker schema
than the API server enforces. `source.json` carries a SHA-256 per file, and
`validate-platform-manifests.mjs` verifies every digest before it reads a
single schema. Its `--self-test` mutates a schema in memory and fails unless
the digest check rejects it, so the integrity path is exercised on every run
rather than trusted.

**Stale or hand-moved pin.** Bumping `upstream.ref` without re-vendoring, or
re-vendoring without moving the pin, leaves the digests agreeing with each
other while describing a commit whose schemas are different.
`sync-crd-schemas.mjs --check` reads each file from upstream *at the pinned
ref* and requires byte equality, so the pin and its contents cannot diverge.
The `crd-schema-drift` CI job checks that SHA out and runs it on every PR.

Both halves fail loudly. An unreachable upstream, a missing file, a checkout on
the wrong commit, or a fetched file that is not a CRD all exit non-zero — there
is no path that reports success without having compared something.

## Refreshing

```sh
# re-vendor at the currently pinned ref (repairs a damaged copy)
npm run schemas:sync

# adopt a newer operator API: move the pin and re-vendor in one step
npm run schemas:sync -- --ref=<40-char-sha>
```

Both rewrite `source.json`'s digests. Review the schema diff and ship it with
whatever `platform.yaml` change it implies. Fixes belong upstream — never
hand-edit a file in this directory.

Verify without writing (what CI runs):

```sh
npm run schemas:check
```

It reads upstream from `raw.githubusercontent.com` at the pinned ref by
default; set `EKS_AGENT_PLATFORM_DIR` to a checkout of that exact commit to run
it offline.

## What the gate does and does not enforce

`controller-gen` emits OpenAPI v3 schemas without `additionalProperties: false`,
so an off-the-shelf JSON Schema validator accepts any invented field —
Kubernetes then prunes it silently at apply time. The validator therefore walks
the schema itself and rejects properties that are not declared, alongside the
usual `required` / `type` / `enum` / `pattern` / bounds checks, and asserts each
kind's scope from the CRD's own `spec.scope`.

It does not evaluate `x-kubernetes-validations` CEL rules. The one that
constrains this manifest — `Platform.spec.identity`'s mutual exclusion of
`allowedModels` and `allowedModelFamilies` — is asserted explicitly in the
validator's consistency pass instead. The rest are enforced by the API server
at admission.
