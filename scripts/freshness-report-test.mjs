#!/usr/bin/env node
/**
 * Assert what the CRD freshness report SAYS, by running it.
 *
 *   node scripts/freshness-report-test.mjs              # the blocking gate
 *   node scripts/freshness-report-test.mjs --self-test  # prove the gate still rejects
 *
 * `.github/workflows/crd-schema-freshness.yml` copies the report verbatim into
 * an issue body it re-edits weekly, then adds a remediation block of its own.
 * The body refreshes every Monday; what it says does not. A commit resolved
 * during one run and printed unqualified is presented as the answer for as long
 * as the issue stays open, so a reader opening it on any other day gets an
 * instruction naming a commit that is not the newest. Following it re-vendors
 * to the wrong ref AND closes an issue that should stay open — a wrong
 * instruction that also dismisses its own warning.
 *
 * So the property is about emitted bytes, not about the code that builds them.
 * A report constructed impeccably from a variable holding a run-time commit is
 * the defect; a report naming `--ref=latest` is not, however it was assembled.
 * Every assertion below reads output.
 *
 * ── What this covers ──
 *
 *   1. A pin behind upstream exits 2 — the "behind" verdict, distinct from the
 *      1 that every way of failing to reach a verdict exits.
 *   2. No upstream commit id appears in the report. Two scans, because either
 *      alone leaves a shape through: every commit the fixture built is looked
 *      for at seven characters and up, and any hex run of twelve or more is
 *      rejected whichever commit it belongs to. The second is what makes it a
 *      structural refusal rather than a check for known bad strings, so a later
 *      rewrite cannot reintroduce the staleness by printing a sha somewhere
 *      else; the first is what closes the abbreviations too short for it.
 *   3. The remediation names `--ref=latest` — a command that resolves the
 *      answer rather than one day's answer.
 *   4. That command RUNS, and lands the pin on the fixture's newest commit
 *      touching the vendored path. 3 and 4 together are the point: the
 *      instruction is correct AND the instruction works.
 *   5. Re-running the report after following it reports current. The loop
 *      closes, so an issue the workflow closes is one that was actually fixed.
 *      The report compares upstream at the pin against upstream at the newest
 *      commit, so a pin that landed on the newest makes this quiet by
 *      construction — 4 subsumes it for every break the mutant table can
 *      express, and no mutant names it.
 *   6. A clone that cannot answer is refused rather than answered from. `latest`
 *      resolves against whatever upstream a run is given, and two shapes of
 *      given upstream produce a confident wrong answer: a shallow clone, where
 *      every path reads as introduced at the boundary so the pin is current
 *      against itself, and a clone that does not descend from the pin, where
 *      `latest` names something older than what is already vendored and the
 *      remediation reverts the schemas it was printed about.
 *   7. A vendored schema removed upstream reports as drift and not as an
 *      unreachable upstream — the workflow files an issue on the first and
 *      nothing on the second.
 *   8. The workflow's own remediation block — bytes the reader sees beside the
 *      report, written in YAML rather than by the script — names the same
 *      command and no commit.
 *
 * Both seams run every applicable assertion: the checkout, and GitHub through a
 * `--import` stub answering api.github.com and raw.githubusercontent.com out of
 * the same fixture repository. The scheduled workflow uses only the GitHub seam,
 * so driving the checkout alone would leave the fix removable in the only place
 * it is read. Where the two seams reach upstream differently — a git argument on
 * one, a query parameter on the other — the mutant is written per seam, because
 * one mutant would be a no-op on the seam it did not name and would report the
 * fix present there on that evidence.
 *
 * `--self-test` breaks each property and fails unless the named assertion
 * catches it, so the gate's own guards stay honest rather than asserted once.
 *
 * ── What this does not cover ──
 *
 * It asserts nothing about `scripts/sync-vendored.mjs --freshness`, which
 * carries the same defect in a stronger form — it prints a full resolved SHA as
 * the `--ref=` argument. That file is a byte-identical vendored copy of
 * `library/scripts/sync-vendored.mjs` in nanohype/nanohype, and
 * `sync:vendored:check` requires it to stay one, so the fix belongs upstream.
 * `REPORTS` below is a table for that reason: adopting the fixed library adds a
 * row rather than a second harness.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const SELF_TEST = process.argv.includes("--self-test");
const SEAMS = ["checkout", "github"];

const exec = promisify(execFile);
const digest = (buf) => createHash("sha256").update(buf).digest("hex");
// `-c` rather than the clone's config, because signing is set globally and this
// gate runs inside `npm run check`: a developer with `commit.gpgsign = true` and
// no agent would see the fixture abort in its setup.
const git = (dir, ...args) => exec("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args]);

/** Run a command, returning its output and exit code rather than throwing. */
async function run(cmd, args, opts) {
  try {
    const { stdout, stderr } = await exec(cmd, args, opts);
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * A real upstream repository whose history this test knows.
 *
 * Four commits, and two of them are what make the fixture discriminating.
 *
 * The last touches a file OUTSIDE the vendored path, so the branch tip and the
 * newest commit touching that path differ. A resolver reading `rev-parse HEAD`
 * instead of filtering to the path passes a fixture where the two coincide, and
 * fails this one.
 *
 * The first carries an older revision of the same schemas, so a clone can be
 * parked on a commit that touches the vendored path and that the pin descends
 * from — an un-fetched clone, the state in which `latest` names something older
 * than what is already vendored and the remediation reverts the schemas.
 */
async function buildFixture(scratch, upstreamPath, files) {
  const dir = join(scratch, "upstream");
  await mkdir(join(dir, upstreamPath), { recursive: true });
  await git(scratch, "init", "-q", dir);
  await git(dir, "config", "user.email", "gate@localhost");
  await git(dir, "config", "user.name", "freshness gate");

  const write = (file, body) => writeFile(join(dir, upstreamPath, file), body);
  const head = async () => (await git(dir, "rev-parse", "HEAD")).stdout.trim();
  const commit = async (subject) => {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", subject);
    return head();
  };

  for (const file of files) await write(file, crd(file, "before the pin"));
  const older = await commit("the schemas as an un-fetched clone still has them");

  for (const file of files) await write(file, crd(file, "at the pin"));
  const pin = await commit("the commit the schemas are pinned to");

  // One schema gains a bound — exactly the change a pin exists to notice, and
  // the one a reader following a stale instruction would fail to adopt.
  await write(files[0], crd(files[0], "at the newest commit", "  pattern: ^[a-z][a-z0-9-]*$"));
  const newest = await commit("tighten a field the tenant manifest sets");

  await writeFile(join(dir, "README.md"), "unrelated to the vendored path\n");
  const tip = await commit("an upstream commit that touches nothing vendored");

  return { dir, older, pin, newest, tip };
}

const crd = (file, marker, extra = "") =>
  "apiVersion: apiextensions.k8s.io/v1\n" +
  "kind: CustomResourceDefinition\n" +
  `metadata:\n  name: ${file.replace(/\.yaml$/, "")}\n` +
  `spec:\n  marker: ${marker}\n${extra ? `${extra}\n` : ""}`;

/**
 * Every commit id the text is forbidden to carry, at every abbreviation a reader
 * could act on. `git rev-parse` accepts seven characters, so that is the floor;
 * below it there is no identifier to follow.
 *
 * Two scans, because either alone lets a shape through. Naming the commits the
 * fixture built catches any abbreviation of them, including ones too short for a
 * pattern to tell from a word. A structural scan catches a commit the fixture
 * never heard of, which is the only kind a rewrite could introduce. The
 * structural one requires a digit: `defaced` and `acceded` are seven hex
 * characters and are words, while a sha of seven characters is all-letters about
 * once in a thousand.
 *
 * Both are case-insensitive. An uppercase sha resolves under `git cat-file` like
 * any other, so it is an identifier a reader can act on.
 */
function commitIdsIn(text, forbidden, pin) {
  // The pin is this repo's own state, read from the manifest under test — a fact
  // about the commit being reported on, not a run-time resolution, and what
  // tells the reader which pin is behind. Removed before the scan rather than
  // exempted, so it cannot mask a resolved id printed next to it.
  let scrubbed = text.toLowerCase();
  if (pin) {
    for (const form of [pin, pin.slice(0, 12), pin.slice(0, 7)]) {
      scrubbed = scrubbed.split(form).join("«pin»");
    }
  }
  const found = [];
  for (const [label, sha] of Object.entries(forbidden)) {
    if (scrubbed.includes(sha.slice(0, 7).toLowerCase()))
      found.push(`${label} (${sha.slice(0, 12)})`);
  }
  for (const hex of scrubbed.match(/\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,}\b/g) ?? []) {
    found.push(`an unrecognised commit id (${hex.slice(0, 12)})`);
  }
  return found;
}

/* ──────────────────────────── the assertions ─────────────────────────── */

/**
 * A `--import` preload answering api.github.com and raw.githubusercontent.com out
 * of the fixture repository, so the GitHub seam runs against the same history the
 * checkout seam does.
 *
 * The scheduled workflow uses only this seam. Driving the checkout seam alone
 * leaves the whole fix removable here with every assertion still green, which is
 * the seam that matters least being the only one under test. Nothing in the
 * script changes to make this possible — the stub replaces `globalThis.fetch`,
 * which is the boundary the script already calls.
 */
const FETCH_STUB = (dir) => `import { execFileSync } from "node:child_process";

const DIR = ${JSON.stringify(dir)};
const git = (args, encoding) => execFileSync("git", ["-C", DIR, ...args], { encoding });
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

globalThis.fetch = async (url) => {
  const at = new URL(String(url));

  // GET /repos/<owner>/<repo>/commits[?path=<path>]&per_page=1
  // No \`path\` means the branch tip, which is what the real endpoint returns and
  // what makes a request that drops the filter observably different here.
  if (at.hostname === "api.github.com") {
    const path = at.searchParams.get("path");
    const args = ["log", "-1", "--format=%H", "HEAD", ...(path ? ["--", path] : [])];
    const sha = git(args, "utf8").trim();
    return sha ? json([{ sha }]) : json([]);
  }

  // GET /<owner>/<repo>/<ref>/<path>/<file>
  if (at.hostname === "raw.githubusercontent.com") {
    const [, , ref, ...rest] = at.pathname.slice(1).split("/");
    try {
      return new Response(git(["show", ref + ":" + rest.join("/")], null), { status: 200 });
    } catch {
      return new Response("404: Not Found", { status: 404, statusText: "Not Found" });
    }
  }

  throw new Error("the fixture serves no host " + at.hostname);
};
`;

/**
 * Run one freshness report against a fixture upstream and assert on its bytes.
 *
 * @param {string} tree - a repo-shaped directory holding the script under test.
 * @param {"checkout"|"github"} seam - how the run reaches upstream.
 * @returns {Promise<Array<{name: string, passed: boolean, detail?: string}>>}
 */
async function assertReport(report, tree, fx, seam = "checkout") {
  const cases = [];
  const record = (name, passed, detail) => cases.push({ name, passed, detail });
  const label = `${report.label} (${seam})`;
  const env =
    seam === "checkout"
      ? { ...process.env, [report.dirvar]: fx.dir }
      : {
          ...process.env,
          [report.dirvar]: "",
          NODE_OPTIONS: `--import=${pathToFileURL(join(tree, "fetch-stub.mjs")).href}`,
        };
  // An empty string is falsy to the script's `process.env.X` read, which is how
  // the GitHub seam is selected without deleting a variable the parent may need.
  if (seam === "github") delete env[report.dirvar];
  const invoke = (args) => run("node", [report.script, ...args], { cwd: tree, env });

  const freshness = await invoke(report.freshnessArgs);

  // 2 is "behind"; 1 is every way of failing to reach a verdict. Collapsing them
  // would let a month of failed lookups read as a month of confirmed drift.
  record(
    `${label}: a behind pin exits 2`,
    freshness.code === 2,
    `exit ${freshness.code}\n${freshness.out}`,
  );
  if (freshness.code !== 2) return cases;

  const named = commitIdsIn(
    freshness.out,
    { "upstream's newest commit": fx.newest, "the branch tip": fx.tip },
    fx.pin,
  );
  record(
    `${label}: the report names no upstream commit id`,
    named.length === 0,
    `it names ${named.join(", ")}\n${freshness.out}`,
  );

  record(
    `${label}: the remediation names \`${report.remediation}\``,
    freshness.out.includes(report.remediation),
    freshness.out,
  );

  // Naming the command does not help if an unfollowable placeholder sits beside
  // it — the reader still has to resolve a commit, and the nearest one in view is
  // whatever the last run printed.
  record(
    `${label}: the report asks the reader to resolve no commit`,
    !/--ref=<[^>]*>/.test(freshness.out),
    "it names a `--ref=<...>` placeholder alongside the command\n" + freshness.out,
  );

  // The instruction has to work, not merely read correctly. Run the command the
  // report names against the same fixture, and require the pin to land on the
  // newest commit touching the vendored path — not on the branch tip, which is a
  // different commit here on purpose.
  const sync = await invoke(report.syncArgs("latest"));
  const landed = sync.code === 0 ? await report.readPin(tree) : `not written (exit ${sync.code})`;
  record(
    `${label}: the command it names lands the pin on upstream's newest`,
    landed === fx.newest,
    `the pin is ${landed}, want ${fx.newest}` +
      (landed === fx.tip
        ? " — it resolved the branch tip rather than the newest commit touching the vendored path"
        : "") +
      `\n${sync.out}`,
  );

  const after = await invoke(report.freshnessArgs);
  record(
    `${label}: following it makes the report stop firing`,
    after.code === 0,
    `exit ${after.code}\n${after.out}`,
  );
  return cases;
}

/**
 * A clone that cannot answer must say so, not answer anyway.
 *
 * `latest` resolves against whatever upstream the run is given, and two shapes of
 * given upstream produce a confident wrong answer rather than an error. Both are
 * reachable by an operator following the remediation on a laptop, and one of them
 * is the shape CI already builds for the blocking gate.
 */
let hostileRun = 0;
async function assertHostileCheckouts(report, work, fx, source, planted) {
  const run_ = hostileRun++;
  const cases = [];
  const record = (name, passed, detail) => cases.push({ name, passed, detail });
  const { label } = report;
  const at = async (dir) => {
    let tree = planted;
    if (!tree) {
      tree = join(work, `hostile-${run_}-${cases.length}`);
      await report.plant(tree, fx, source);
    }
    return run("node", [report.script, ...report.freshnessArgs], {
      cwd: tree,
      env: { ...process.env, [report.dirvar]: dir },
    });
  };

  // Depth one AT THE PIN — the shape ci.yml clones for `schemas:check`, and so
  // the clone an operator already has. `git log` treats the shallow boundary as
  // parentless, so every path reads as introduced there and the newest commit
  // touching the vendored path is HEAD: the pin, which the report then finds
  // current against itself. Answering rather than refusing here is a silent
  // "no drift" for as long as the clone stays shallow.
  const shallow = join(work, `shallow-${run_}`);
  await mkdir(shallow, { recursive: true });
  await exec("git", ["-C", shallow, "init", "-q"]);
  await exec("git", ["-C", shallow, "fetch", "-q", "--depth", "1", fx.dir, fx.pin]);
  await exec("git", ["-C", shallow, "checkout", "-q", "FETCH_HEAD"]);
  const onShallow = await at(shallow);
  record(
    `${label}: a shallow clone is refused, not answered from`,
    onShallow.code === 1 && /shallow/i.test(onShallow.out),
    `exit ${onShallow.code}\n${onShallow.out}`,
  );

  // A clone parked before the pin. `latest` there names a commit older than what
  // is already vendored, so following the remediation reverts the schemas — the
  // report's instruction undoing the report's own subject.
  const behind = join(work, `behind-${run_}`);
  await exec("git", ["clone", "-q", "--no-local", fx.dir, behind]);
  await exec("git", ["-C", behind, "checkout", "-q", fx.older]);
  const onBehind = await at(behind);
  record(
    `${label}: a clone that does not descend from the pin is refused`,
    onBehind.code === 1 && /does not precede/.test(onBehind.out),
    `exit ${onBehind.code}\n${onBehind.out}`,
  );
  return cases;
}

/**
 * A vendored schema removed upstream after the pin is drift, and drift is what
 * the scheduled workflow files an issue for. Reported as an unreachable upstream
 * it exits 1, and the workflow files nothing on a 1 — the one case where a schema
 * this repo validates against has vanished would be the case nobody hears about.
 *
 * Only the GitHub seam can get this wrong: the checkout seam reads through
 * `gitShow`, which returns null for an absent path already.
 */
let removedRun = 0;
async function assertRemovedUpstream(report, work, fx, source, planted) {
  const run_ = removedRun++;
  const cases = [];
  const tree = planted ?? join(work, `removed-${run_}`);
  if (!planted) await report.plant(tree, fx, source);
  const gone = join(work, `upstream-removed-${run_}`);
  await exec("git", ["clone", "-q", "--no-local", fx.dir, gone]);
  await exec("git", [
    "-C",
    gone,
    "-c",
    "commit.gpgsign=false",
    "rm",
    "-q",
    `${source.upstream.path}/${source.files[0].file}`,
  ]);
  await exec("git", ["-C", gone, "-c", "commit.gpgsign=false", "commit", "-qm", "drop a CRD"]);
  await writeFile(join(tree, "fetch-stub.mjs"), FETCH_STUB(gone));

  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(join(tree, "fetch-stub.mjs")).href}`,
  };
  delete env[report.dirvar];
  const out = await run("node", [report.script, ...report.freshnessArgs], { cwd: tree, env });
  cases.push({
    name: `${report.label} (github): a schema removed upstream reports as drift, not as an unreachable upstream`,
    passed: out.code === 2 && /removed or renamed/.test(out.out),
    detail: `exit ${out.code}\n${out.out}`,
  });
  return cases;
}

/**
 * The workflow writes a remediation block of its own beside the report. Those
 * bytes reach the same reader on the same day and go stale the same way, and no
 * assertion on the script can see them.
 */
async function assertWorkflowBody(path) {
  const label = "crd-schema-freshness.yml";
  const cases = [];
  const record = (name, passed, detail) => cases.push({ name, passed, detail });

  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    record(`${label}: the workflow carrying the report exists`, false, err.message);
    return cases;
  }
  const matched = text.match(/body=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/);
  if (!matched) {
    record(
      `${label}: the issue body is where this expects it`,
      false,
      "no `body=$(cat <<EOF ... EOF` heredoc — every assertion below would have verified nothing",
    );
    return cases;
  }
  const body = matched[1];

  record(
    `${label}: the issue body names \`npm run schemas:sync -- --ref=latest\``,
    body.includes("npm run schemas:sync -- --ref=latest"),
    body,
  );
  record(
    `${label}: the issue body asks the reader to resolve no commit`,
    !/--ref=<[^>]*>/.test(body),
    "it names a `--ref=<...>` placeholder the reader has to resolve, and the nearest sha in view is the one the report printed",
  );
  const stray = commitIdsIn(body, {}, null);
  record(`${label}: the issue body names no commit id`, stray.length === 0, stray.join(", "));
  return cases;
}

/* ───────────────────────── the reports under test ────────────────────── */

const REPORTS = [
  {
    label: "schemas:freshness",
    script: "scripts/sync-crd-schemas.mjs",
    source: join(ROOT, "scripts", "sync-crd-schemas.mjs"),
    dirvar: "EKS_AGENT_PLATFORM_DIR",
    manifest: join("schemas", "crd", "source.json"),
    freshnessArgs: ["--freshness"],
    syncArgs: (ref) => [`--ref=${ref}`],
    remediation: "npm run schemas:sync -- --ref=latest",

    async read() {
      return JSON.parse(await readFile(join(ROOT, this.manifest), "utf8"));
    },

    /**
     * A tree the script can run in: its own schema directory, vendored
     * faithfully from the fixture at a commit that is not the newest. The
     * digests are real, so the run exercises the same manifest rules the
     * blocking gate does rather than a shape that merely looks like one.
     */
    async plant(tree, fx, source) {
      const dir = dirname(join(tree, this.manifest));
      await mkdir(dir, { recursive: true });
      await mkdir(join(tree, "scripts"), { recursive: true });
      await cp(this.source, join(tree, this.script));
      await writeFile(join(tree, "fetch-stub.mjs"), FETCH_STUB(fx.dir));

      const files = [];
      for (const { file } of source.files) {
        const { stdout } = await exec(
          "git",
          ["-C", fx.dir, "show", `${fx.pin}:${source.upstream.path}/${file}`],
          { encoding: "buffer" },
        );
        await writeFile(join(dir, file), stdout);
        files.push({ file, sha256: digest(stdout) });
      }
      const pinned = { ...source, upstream: { ...source.upstream, ref: fx.pin }, files };
      await writeFile(join(tree, this.manifest), `${JSON.stringify(pinned, null, 2)}\n`);
    },

    async readPin(tree) {
      return JSON.parse(await readFile(join(tree, this.manifest), "utf8")).upstream.ref;
    },
  },
];

const WORKFLOW = join(ROOT, ".github", "workflows", "crd-schema-freshness.yml");

/* ────────────────────────────── self-test ───────────────────────────── */

/**
 * Each mutant is the fix removed one way, paired with the assertion that must
 * notice. `script` mutants edit the planted copy, so the real tree is untouched;
 * `workflow` mutants edit a copy of the workflow file.
 *
 * `find` must match exactly once. A mutant that silently applies to nothing is
 * a self-test case that proves the gate rejects something it was never shown.
 */
const MUTANTS = [
  {
    // The line has to become a template literal to interpolate at all: written
    // as a plain string it emits the four characters `${tip}`, names no commit,
    // and proves nothing.
    name: "the remediation names the commit the run resolved",
    target: "script",
    find: '      "    Adopt the newer operator API when convenient: `npm run schemas:sync -- --ref=latest`,\\n" +',
    replace:
      "      `    Adopt the newer operator API when convenient: \\`npm run schemas:sync -- --ref=${tip}\\`,\\n` +",
    caught: "the report names no upstream commit id",
  },
  {
    name: "the verdict line carries the resolved commit, abbreviated",
    target: "script",
    find: "is behind ${path} in ${repository}:",
    replace: "is behind ${repository}@${tip.slice(0, 12)}:",
    caught: "the report names no upstream commit id",
  },
  {
    name: "the remediation goes back to a placeholder the reader must resolve",
    target: "script",
    find: 'schemas:sync -- --ref=latest`,\\n" +',
    replace: 'schemas:sync -- --ref=<sha>`,\\n" +',
    caught: "the remediation names `npm run schemas:sync -- --ref=latest`",
  },
  {
    name: "`latest` is rejected as not a commit SHA",
    target: "script",
    find: 'REF_ARG !== undefined && REF_ARG !== "latest" && !isSha(REF_ARG)',
    replace: "REF_ARG !== undefined && !isSha(REF_ARG)",
    caught: "the command it names lands the pin on upstream's newest",
  },
  {
    name: "`latest` falls back to the pin instead of resolving upstream",
    target: "script",
    find: 'REF_ARG === "latest" ? await upstreamHead(manifest)',
    replace: 'REF_ARG === "latest" ? manifest.upstream.ref',
    caught: "the command it names lands the pin on upstream's newest",
  },
  {
    // Seam-specific, because the path filter is: a git argument on one seam and a
    // query parameter on the other. One mutant would be a no-op on whichever seam
    // it did not name, and would report the fix present there on that evidence.
    name: "`latest` resolves the branch tip rather than the vendored path's newest commit",
    target: "script",
    seams: ["checkout"],
    find: '"--format=%H",\n        "HEAD",\n        "--",\n        path,',
    replace: '"--format=%H",\n        "HEAD",',
    caught: "the command it names lands the pin on upstream's newest",
  },
  {
    name: "the upstream query drops the path filter and asks for the branch tip",
    target: "script",
    seams: ["github"],
    find: "/commits?path=${encodeURIComponent(path)}&per_page=1`",
    replace: "/commits?per_page=1`",
    caught: "the command it names lands the pin on upstream's newest",
  },
  {
    name: "a behind pin reports current",
    target: "script",
    find: "  if (behind.length === 0) {\n    out(",
    replace: "  if (true) {\n    out(",
    caught: "a behind pin exits 2",
  },
  {
    name: "a shallow clone is answered from rather than refused",
    target: "script",
    seams: ["checkout"],
    find: 'if (shallow.trim() === "true") {',
    replace: "if (false) {",
    caught: "a shallow clone is refused, not answered from",
    assertions: "hostile",
  },
  {
    name: "a clone older than the pin is accepted, so `latest` reverts the schemas",
    target: "script",
    seams: ["checkout"],
    find: '        await exec("git", ["-C", CHECKOUT, "merge-base", "--is-ancestor", ref, head]);',
    replace: "        void 0;",
    caught: "a clone that does not descend from the pin is refused",
    assertions: "hostile",
  },
  {
    name: "a schema removed upstream reads as an unreachable upstream",
    target: "script",
    seams: ["github"],
    find: "fetchAtRef(repository, path, tip, file, { absentIsNull: true }),",
    replace: "fetchAtRef(repository, path, tip, file),",
    caught: "a schema removed upstream reports as drift, not as an unreachable upstream",
    assertions: "removed",
  },
  {
    name: "the report names the resolved commit in upper case",
    target: "script",
    find: '      "    review the schema diff, and ship it with whatever platform.yaml change it implies.\\n" +',
    replace: "      `    review the schema diff (upstream is at ${tip.toUpperCase()}).\\n` +",
    caught: "the report names no upstream commit id",
  },
  {
    name: "the report names an unfollowable placeholder beside the command",
    target: "script",
    find: '      "\\n    `latest` resolves upstream when the re-vendor runs, so this line is answerable on\\n" +',
    replace:
      '      "\\n    (or pin one commit: `npm run schemas:sync -- --ref=<sha>`)\\n" +\n' +
      '      "\\n    `latest` resolves upstream when the re-vendor runs, so this line is answerable on\\n" +',
    caught: "the report asks the reader to resolve no commit",
  },
  {
    name: "the issue body names a short resolved commit",
    target: "workflow",
    find: "          npm run platform:validate",
    replace: "          npm run platform:validate\n          # upstream is at 0f56302",
    caught: "the issue body names no commit id",
  },
  {
    name: "the issue body goes back to a placeholder the reader must resolve",
    target: "workflow",
    find: "npm run schemas:sync -- --ref=latest",
    replace: "npm run schemas:sync -- --ref=<sha>",
    caught: "the issue body asks the reader to resolve no commit",
  },
  {
    name: "the issue body names the commit the run resolved",
    target: "workflow",
    find: "          npm run platform:validate",
    replace:
      "          npm run platform:validate\n          # pinned at 0f56302c9e2d228c684bd36823dc15576016d9ba",
    caught: "the issue body names no commit id",
  },
];

function applyMutation(text, mutant) {
  const occurrences = text.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `the mutant "${mutant.name}" matches its target ${occurrences} times, not once — ` +
        "it would prove the gate rejects something it was never shown",
    );
  }
  return text.split(mutant.find).join(mutant.replace);
}

/* ──────────────────────────────── main ──────────────────────────────── */

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), "freshness-report-"));
  const cases = [];

  try {
    for (const report of REPORTS) {
      const source = await report.read();
      const files = source.files.map((f) => f.file);
      const work = await mkdtemp(join(scratch, "case-"));
      const fx = await buildFixture(work, source.upstream.path, files);

      // A tree per run, never a tree per case: the fourth assertion RUNS the
      // remediation, which moves the pin. A second run against the same tree
      // starts from a pin that is already current and asserts nothing.
      let n = 0;
      const fresh = async (mutant) => {
        const tree = join(work, `tree-${n++}`);
        await report.plant(tree, fx, source);
        if (mutant) {
          const at = join(tree, report.script);
          await writeFile(at, applyMutation(await readFile(at, "utf8"), mutant));
        }
        return tree;
      };

      if (!SELF_TEST) {
        for (const seam of SEAMS) {
          cases.push(...(await assertReport(report, await fresh(), fx, seam)));
        }
        cases.push(...(await assertHostileCheckouts(report, work, fx, source)));
        cases.push(...(await assertRemovedUpstream(report, work, fx, source)));
        continue;
      }

      // A mutant has to be caught on BOTH seams. The scheduled workflow reads
      // the GitHub one, so a fix removable there is a fix that is not there.
      for (const mutant of MUTANTS.filter((m) => m.target === "script")) {
        for (const seam of mutant.seams ?? SEAMS) {
          const tree = await fresh(mutant);
          const results =
            mutant.assertions === "hostile"
              ? await assertHostileCheckouts(report, work, fx, source, tree)
              : mutant.assertions === "removed"
                ? await assertRemovedUpstream(report, work, fx, source, tree)
                : await assertReport(report, tree, fx, seam);
          cases.push(verdict(mutant, results, seam));
        }
      }
    }

    if (!SELF_TEST) {
      cases.push(...(await assertWorkflowBody(WORKFLOW)));
    } else {
      const pristine = await readFile(WORKFLOW, "utf8");
      for (const mutant of MUTANTS.filter((m) => m.target === "workflow")) {
        const copy = join(scratch, `workflow-${cases.length}.yml`);
        await writeFile(copy, applyMutation(pristine, mutant));
        cases.push(verdict(mutant, await assertWorkflowBody(copy), null));
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  process.stdout.write("\n");
  for (const c of cases) process.stdout.write(`  ${c.passed ? "✓" : "✗"} ${c.name}\n`);

  const failed = cases.filter((c) => !c.passed);
  if (failed.length > 0) {
    process.stderr.write(
      `\n  ✗ ${failed.length} of ${cases.length} ${SELF_TEST ? "self-test case(s)" : "freshness-report assertion(s)"} do not hold:\n` +
        `${failed
          .map(
            (c) =>
              `      ${c.name}${c.detail ? `\n          ${c.detail.split("\n").join("\n          ")}` : ""}`,
          )
          .join("\n")}\n\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    SELF_TEST
      ? `\n✓ all ${cases.length} mutants were caught by the assertion named for them\n`
      : `\n✓ all ${cases.length} assertions hold — the freshness report names a command, not a commit\n`,
  );
}

/** A mutant passes only when the assertion NAMED for it is among the failures. */
function verdict(mutant, results, seam) {
  const name = `${mutant.name} → caught${seam ? ` on the ${seam} seam` : ""} by "${mutant.caught}"`;
  const caught = results.find((c) => c.name.endsWith(mutant.caught));
  if (!caught) {
    return {
      name,
      passed: false,
      detail:
        `no assertion named "${mutant.caught}" ran. The assertions that did:\n` +
        results.map((c) => `  ${c.passed ? "✓" : "✗"} ${c.name}`).join("\n"),
    };
  }
  return {
    name,
    passed: !caught.passed,
    detail: caught.passed ? "the assertion still passed — the mutant survives the gate" : undefined,
  };
}

main().catch((err) => {
  process.stderr.write(`\n  ✗ freshness-report-test failed: ${err.stack ?? err.message}\n\n`);
  process.exit(1);
});
