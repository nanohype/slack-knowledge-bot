# Evals

Tests assert that code does what it says. Evals measure whether a **model**
does, on these prompts — and the answer is a rate, not a boolean.

Both live here, told apart by name, because one of them must never be mistaken
for the other:

| | Command | Needs a model | Runs on every PR | Answers |
| --- | --- | --- | --- | --- |
| **Offline** | `npm test` | no | yes | Is the golden set still a golden set? Does the grader grade? |
| **Model** | `npm run eval` | yes | its own CI job | Does the model hold up on these prompts? |

## Running the model tier

```sh
EVAL_LLM=bedrock npm run eval            # AWS credential chain
EVAL_MODEL=<profile-id> EVAL_LLM=bedrock npm run eval
```

`EVAL_LLM` decides whether the tier runs at all, and the two states are
deliberately asymmetric:

- **Unset** — skipped. Running the unit suite locally should not bill anyone.
- **Set** — must work. A configured-but-broken provider is a hard failure, never
  a skip, because a green run has to mean the evals executed.

That asymmetry is the whole point. A suite that quietly skips its model tier
and reports green is worse than no suite: it converts an absence of evidence
into a claim of safety.

## The two kinds of case

Every case in `fixtures/rag.json` declares a `kind`, and it decides how a
failure reads.

**`capability`** — the model answering from context: grounded claims, typed
citations, honest refusal when the docs cannot answer. Models legitimately
vary in phrasing, so these are scored as a **rate against a floor**, the same
shape as a coverage floor. Raise `capabilityFloor` in the fixture as the
prompts improve; a floor nobody ratchets stops being a floor.

**`adversarial`** — the model holding a boundary against a hostile document or
query. There is no acceptable rate below 100%. A refusal that works four times
in five is not a control, it is a coin flip with good manners. Each of these
is asserted individually so a failure names the case that broke.

The adversarial set covers the channels that are actually attacker-controlled
here: **retrieved document content** (a page the caller can ACL-read puts
text into someone else's prompt), the user query itself (RT-03), tag smuggling
against the fence, system-prompt exfiltration, and fabricating a plausible
policy claim that would look like ground truth in Slack.

## Retrieval vs generation

This suite measures the **generator** over fixture hit lists — the same
`createGenerator` path production uses after ACL filtering. Hybrid retrieval
(RRF fusion of k-NN + lexical ranks) is covered by unit tests on
`rrfFusion` and the retriever; a regression there shows as empty or wrong
hits, not as an eval score. Live embedding-recall evals need a seeded
pgvector corpus and are not part of this CI tier.

## Adding a case

Add an object to `fixtures/rag.json`. The offline tier validates the shape
and will reject a case that cannot fail — an adversarial case with nothing in
`absent` and no citation constraint would pass forever while reading as a
control.

Write the `rationale` for the person who sees this case go red at 2am. It is
the only field that explains why anyone should care.

Grading matches terms case-insensitively as substrings in the answer text.
Each entry in `mentions` is a set that must appear in full. Citations are
typed (`mustCite` / `noCite` / `mustHaveStale`) — this product's contract is
a cited answer, not free prose.

## What an eval failure means

A capability failure is usually a prompt problem, sometimes a fixture that was
never fair. Read the `rationale`, then decide which.

An adversarial failure is a security finding. The fence in
`src/vendor/runtime/guardrails.ts` (applied in `src/rag/generator.ts`) gives
the model what it needs to refuse; it does not force refusal. These cases are
the measurement of whether it actually does, and a regression here means
untrusted document content is reaching instruction position.
