# SlackKnowledgeBot QA Playbook — Fresh Deploy to First Grounded Answer

**Audience:** operator/QA engineer validating a clean SlackKnowledgeBot deploy end-to-end.
**Time:** ~45 minutes, most of it waiting on the ArgoCD sync + OAuth consent screens.
**Outcome:** `@yourbot what's our PTO policy?` returns a Claude-generated answer grounded in a real Notion page, with a clickable citation.

This doc is operator-first: paste-ready commands, exact console click-paths, zero narrative filler. Each step tells you what to do, how to verify it worked, and — in Appendix B — what can go wrong. If a command fails with an error you don't recognise, **scan Appendix B first**; every non-obvious failure we've seen during this project is catalogued there.

---

## 1. Prereqs (5 min)

| Thing | Why |
|---|---|
| AWS account with admin | Apply the Platform CR, Bedrock Marketplace subscribe, secrets seeding |
| AWS CLI + SSO profile | `aws sso login --profile <name>` |
| `kubectl` + cluster access | Apply `platform.yaml`, exec into pods, read logs |
| `argocd` CLI (optional) | Inspect ArgoCD app sync/health from the terminal |
| Node 24 + npm | Matches the Docker base image and CI runtime |
| Slack workspace admin | To create the bot app, enable Socket Mode, install |
| A public domain you own | cert-manager TLS + DNS for the ingress; OAuth providers reject non-HTTPS callbacks |
| Gmail (or any email) | WorkOS Directory Sync signup |

Set the AWS profile + region for everything that follows, and point `kubectl` at the target cluster:

```bash
export AWS_PROFILE=<your-sso-profile>
export AWS_REGION=us-west-2
aws sts get-caller-identity   # sanity
kubectl config current-context   # confirm you're on the right cluster
```

---

## 2. Deploy the tenant (15 min)

The app ships as a Platform tenant of the `protohype` team on the `eks-agent-platform` operator. There's no in-repo IaC and no manual rollout — the substrate is OpenTofu/Terragrunt in `landing-zone`, and ArgoCD reconciles the Helm chart (`chart/`) from git. Three moving parts: the substrate, the Platform CR, and the ApplicationSet entry.

```bash
git clone <repo> && cd slack-knowledge-bot
npm ci && npm run build:oauth
```

### 2a. Substrate (landing-zone)

`landing-zone/components/aws/slack-knowledge-bot-platform/` provisions the shared AWS state: DynamoDB ×3 (tokens, audit, identity cache), SQS + DLQ, the S3 audit bucket, Aurora Serverless v2 (pgvector), ElastiCache Redis, the KMS token key, and the seeded `slack-knowledge-bot/staging/app-secrets`. Apply its staging entry per that repo's `CLAUDE.md`, then grab the outputs you'll plumb into the chart:

```bash
# from landing-zone, in the component's terragrunt dir
terragrunt output irsa_role_arn      # → drops into chart/values-staging.yaml aws.platformRoleArn
terragrunt output pg_host            # → tenantInfra.pgHost
```

These outputs are wired into `chart/values-staging.yaml` under `aws.platformRoleArn` + `tenantInfra.*`. See `docs/secrets.md` for the secret payload shape.

### 2b. Platform CR

Apply the Platform CR once. The operator reconciles the namespace, ResourceQuota, LimitRange, default-deny NetworkPolicy, ArgoCD AppProject, the IRSA role, KMS grants, and the S3 bucket policy:

```bash
kubectl apply -f platform.yaml
kubectl wait --for=condition=Ready platform/slack-knowledge-bot \
  -n tenants-protohype --timeout=300s
```

### 2c. GitOps

`gitops/applicationset-entry.yaml` is registered in `nanohype/eks-gitops` (`applicationsets/apps-tenants.yaml`). ArgoCD renders the chart per cluster/env and rolls out the main `Deployment`, the `Ingress` (ingress-nginx + cert-manager TLS for `/health` + `/oauth/:provider/{start,callback}`), and the KEDA-scaled audit-consumer `Deployment`. New image tags flow: release workflow → GHCR → ArgoCD auto-syncs.

The ingress hostname is whatever `chart/values-staging.yaml` sets under `ingress.hosts[0].host` (e.g. `slack-knowledge-bot-staging.example.com`); cert-manager issues its TLS cert. That hostname is `APP_BASE_URL` for the env.

**Verify:**

```bash
# Pods up + rollout complete
kubectl -n tenants-protohype get pods -l app.kubernetes.io/name=slack-knowledge-bot
kubectl -n tenants-protohype rollout status deploy/slack-knowledge-bot

# ArgoCD app synced + healthy (optional CLI)
argocd app get slack-knowledge-bot-staging

# Health endpoint via the ingress
curl -s "https://slack-knowledge-bot-staging.example.com/health"
# → {"status":"ok","service":"slack-knowledge-bot"}
```

**Can go wrong:** [B.1 Ingress / cert-manager TLS not ready](#b1-ingress--cert-manager-tls-not-ready) • [B.2 Pod crash-loops at boot with Zod validation](#b2-pod-crash-loops-at-boot-with-zod-validation)

---

## 3. Enable Bedrock model access (5 min)

The `us.anthropic.claude-sonnet-4-6` inference profile routes across **us-east-1, us-east-2, us-west-2** based on load. Each region enables on first-invoke, and the subscribe action needs Marketplace permissions — which the pod's IRSA role deliberately doesn't have. **Your admin session does.**

For each of us-east-1, us-east-2, us-west-2:

1. AWS Console → switch region
2. Bedrock → **Chat / Test** (or Playgrounds → Chat)
3. Model: **Claude Sonnet 4.6**
4. Type anything, hit Send
5. If prompted for "use case details" (first-time Anthropic access), fill it in — approved in <2 min

Same for Titan embeddings (us-west-2 only):

1. Bedrock us-west-2 → Playgrounds → Chat or Text
2. Model: **Titan Embeddings v2**
3. Send anything

**Verify:** from your workstation —

```bash
aws bedrock-runtime invoke-model \
  --model-id us.anthropic.claude-sonnet-4-6 \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/bedrock-probe.json && cat /tmp/bedrock-probe.json
```

Should return a small JSON with `content[0].text`. If it errors with `aws-marketplace:Subscribe`, repeat the playground invoke in the failing region.

**Can go wrong:** [B.3 Bedrock AccessDenied Marketplace](#b3-bedrock-accessdenied-marketplace) • [B.4 Bedrock ValidationException on-demand throughput](#b4-bedrock-validationexception-on-demand-throughput)

---

## 4. WorkOS identity (5 min)

SlackKnowledgeBot maps Slack user → workforce-directory user by email. WorkOS Directory Sync is the default provider.

1. [dashboard.workos.com](https://dashboard.workos.com) → sign up (any email works)
2. Create an Organization (name doesn't matter)
3. **Directory Sync** → Connect a directory → pick any type (Custom SCIM v2.0 is quickest for a demo)
4. Under Users, add yourself — **email must match your Slack profile email**
5. Copy the `directory_01…` ID from the URL
6. **API Keys** → Create production key → copy the `sk_…` value

Save both values — you'll paste them into the secrets JSON in §7.

**Verify:** from your workstation —

```bash
WORKOS_KEY=<your sk_ key>
WORKOS_DIR=<your directory_01… ID>
curl -sS -H "Authorization: Bearer $WORKOS_KEY" \
  "https://api.workos.com/directory_users?directory=$WORKOS_DIR&limit=1" | jq '.data[0].email'
# → "your-slack-email@example.com"
```

**Can go wrong:** [B.5 WorkOS 422 empty directory param](#b5-workos-422-empty-directory-param)

---

## 5. Slack app (5 min)

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch** → pick a name + your workspace
2. **Socket Mode** → toggle **Enable Socket Mode** on
3. In the Socket Mode dialog, click **Generate** to create an App-Level Token. Scope: `connections:write`. Save the `xapp-…` value.
4. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:write`
   - `users:read`
   - `users:read.email`
5. **OAuth & Permissions** → **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`)
6. **Basic Information** → under **App Credentials**, copy **Signing Secret**
7. **Event Subscriptions** → toggle **Enable Events** on → under **Subscribe to bot events** add:
   - `app_mention`
   - `message.im`
   
   → **Save Changes** at the bottom (easy to miss)
8. Click the yellow **Reinstall your app** banner at the top when it appears. Scope changes don't apply until reinstall.
9. Invite the bot to a test channel: `/invite @yourbot` — or just DM it

Save: `SLACK_BOT_TOKEN` (`xoxb-…`), `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` (`xapp-…`).

**Can go wrong:** [B.6 Slack invalid_auth after reinstall](#b6-slack-invalid_auth-after-reinstall) • [B.7 Socket Mode silent — no events reaching bot](#b7-socket-mode-silent--no-events-reaching-bot)

---

## 6. OAuth apps (Notion / Atlassian / Google) (15 min)

All three need the same callback URL pattern:
`https://${SLACK_KNOWLEDGE_BOT_STAGING_DOMAIN}/oauth/{provider}/callback`

### Notion

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**
2. Associated workspace: your personal or team space
3. Type: **Public** (required for OAuth; an Internal integration uses a different auth model)
4. OAuth Domain & URIs → Redirect URI: `https://slack-knowledge-bot.example.com/oauth/notion/callback`
5. Copy **OAuth client ID** and **OAuth client secret**

### Atlassian (Confluence)

1. [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/) → **Create** → **OAuth 2.0 integration**
2. Name the app, create it
3. **Authorization** (left nav) → Callback URL: `https://slack-knowledge-bot.example.com/oauth/atlassian/callback` → **Save changes**
4. **Permissions** → add **Confluence API** → click Configure → add scopes:
   - `read:confluence-content.all`
   - `read:confluence-space.summary`
   
   (`offline_access` is sent at auth-time, not configured here — Atlassian auto-grants it for 3LO apps.)
5. **Distribution** → set to **Sharing** (so you can OAuth to your own workspace — the default "Development" mode blocks that)
6. **Settings** → copy **Client ID** and **Secret**
7. Fetch your Atlassian cloudId (one public HTTP call, no auth):

   ```bash
   curl -sS https://<your-subdomain>.atlassian.net/_edge/tenant_info | jq -r .cloudId
   ```
   
   Save this — you'll paste it into the seed script in §8.

### Google (Drive)

1. [console.cloud.google.com](https://console.cloud.google.com) → pick or create a project
2. **APIs & Services** → **Library** → enable **Google Drive API**
3. **APIs & Services** → **OAuth consent screen**:
   - User type: **External**
   - Fill in app name, user support email, developer email
   - Add your own email as a **Test User** (otherwise you get "Access blocked" at consent time)
4. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://slack-knowledge-bot.example.com/oauth/google/callback`
5. Copy **Client ID** and **Client secret**

**Can go wrong:** [B.8 Google "Access blocked — verification"](#b8-google-access-blocked--verification) • [B.9 Notion token exchange 401](#b9-notion-token-exchange-401) • [B.10 Atlassian "Something went wrong"](#b10-atlassian-something-went-wrong)

---

## 7. Seed app-secrets (2 min)

The landing-zone `slack-knowledge-bot-platform` component seeds `slack-knowledge-bot/staging/app-secrets` with placeholder values. Now overwrite it with real values. **Do not include `STATE_SIGNING_SECRET`** — the substrate generates that one; reseeding would rotate it and break any in-flight OAuth state cookies.

Write the JSON off-tree:

```bash
cat > /tmp/slack-knowledge-bot-staging-secrets.json <<'JSON'
{
  "SLACK_BOT_TOKEN": "xoxb-…",
  "SLACK_SIGNING_SECRET": "…",
  "SLACK_APP_TOKEN": "xapp-…",

  "WORKOS_API_KEY": "sk_…",
  "WORKOS_DIRECTORY_ID": "directory_01…",

  "NOTION_OAUTH_CLIENT_ID": "…",
  "NOTION_OAUTH_CLIENT_SECRET": "…",

  "CONFLUENCE_OAUTH_CLIENT_ID": "…",
  "CONFLUENCE_OAUTH_CLIENT_SECRET": "…",

  "GOOGLE_OAUTH_CLIENT_ID": "…",
  "GOOGLE_OAUTH_CLIENT_SECRET": "…"
}
JSON
```

Push it. The External Secrets Operator syncs Secrets Manager → the k8s `app-secrets` Secret on its refresh interval; restart the Deployment so pods pick up the new values immediately:

```bash
aws secretsmanager put-secret-value \
  --secret-id slack-knowledge-bot/staging/app-secrets \
  --secret-string file:///tmp/slack-knowledge-bot-staging-secrets.json

# Force ESO to resync now (optional — it polls on its own), then roll the pods
kubectl -n tenants-protohype annotate externalsecret slack-knowledge-bot \
  force-sync="$(date +%s)" --overwrite
kubectl -n tenants-protohype rollout restart deploy/slack-knowledge-bot
kubectl -n tenants-protohype rollout status deploy/slack-knowledge-bot
```

After the rollout returns, clean up the file: `rm -P /tmp/slack-knowledge-bot-staging-secrets.json` (macOS) or `shred -u` (Linux).

**Verify:** logs should show Bolt connected, no Zod-validation crash —

```bash
kubectl -n tenants-protohype logs deploy/slack-knowledge-bot --tail=50 \
  | grep 'SlackKnowledgeBot is running'
# → {"level":30,"…","msg":"SlackKnowledgeBot is running"}
```

**Can go wrong:** [B.2 Pod crash-loops at boot with Zod validation](#b2-pod-crash-loops-at-boot-with-zod-validation)

---

## 8. Create test pages + seed pgvector (5 min)

There's no ingestion pipeline in v0.1 — you create real pages in each source, then run `src/scripts/seed-demo.ts` which embeds them via Titan and upserts into the `chunks` table. The script's ACL probes still run at query time, so the doc IDs have to match real pages that your OAuth grant covers.

### 8a. Create three pages

Use the sample content in [Appendix A](#appendix-a-sample-page-content) so the script's prebuilt text matches what you paste. You need:

- One **Notion** page titled `PTO Policy`
- One **Confluence** page titled `On-call Rotation — Platform Team`
- One **Google Doc** titled `Q2 2026 Engineering Roadmap`

### 8b. Grab each page's ID

| Source | Where to find it |
|---|---|
| Notion | URL like `https://www.notion.so/Title-<32-char-hex>`. The trailing 32-char hex is the page ID. |
| Confluence | URL like `https://<site>.atlassian.net/wiki/spaces/FH/pages/<numeric-id>/Title`. Page ID is the numeric segment. |
| Google Drive | URL like `https://docs.google.com/document/d/<alphanumeric-id>/edit`. File ID is between `/d/` and `/edit`. |

### 8c. Plug IDs into the seed script

Edit `src/scripts/seed-demo.ts`. Replace the four `REPLACE_WITH_YOUR_*` placeholders near the top:

- `NOTION_PAGE_ID`
- `CONFLUENCE_CLOUD_ID` (UUID from §6 Atlassian step)
- `CONFLUENCE_PAGE_ID`
- `DRIVE_FILE_ID`

The updated script ships in the next image. Commit + push to `main`; the release workflow builds, scans (Trivy), and publishes the image to GHCR, and ArgoCD auto-syncs the new tag onto the Deployment:

```bash
git commit -am "demo: plug seed-demo page IDs" && git push
# wait for the release workflow + ArgoCD sync, then confirm the new pod is up
kubectl -n tenants-protohype rollout status deploy/slack-knowledge-bot
```

### 8d. Run the seeder

Exec into the running pod and run the seeder there:

```bash
kubectl -n tenants-protohype exec -it deploy/slack-knowledge-bot -- \
  node dist/scripts/seed-demo.js
```

Expected output:

```
[seed] embedding 3 docs via amazon.titan-embed-text-v2:0...
[seed] upserted notion:page:…
[seed] upserted confluence:<cloudId>:…
[seed] upserted drive:file:…
[seed] done. total chunks in table: 3
```

**Verify:**

```bash
kubectl -n tenants-protohype exec -it deploy/slack-knowledge-bot -- \
  node -e "const{Pool}=require('pg');const p=new Pool({host:process.env.PGHOST,port:+process.env.PGPORT,user:process.env.PGUSER,password:process.env.PGPASSWORD,database:process.env.PGDATABASE,ssl:{rejectUnauthorized:false}});p.query('SELECT count(*) FROM chunks').then(r=>console.log('count:',r.rows[0].count)).then(()=>p.end())"
# → count: 3
```

**Can go wrong:** [B.11 pgvector SSL error no_encryption](#b11-pgvector-ssl-error-no_encryption) • [B.12 Placeholders still in seed script](#b12-placeholders-still-in-seed-script)

---

## 9. Per-user OAuth from Slack (2 min)

At this point the stack is up, secrets are live, and pgvector has three rows — but no per-user OAuth tokens exist yet. The first @mention from your Slack account triggers a DM with signed OAuth start links.

1. In Slack: `@yourbot hello`
2. Open the DM from the bot → three links: Connect Notion, Connect Confluence, Connect Google Drive
3. Click each, complete consent on the provider's page (grant the scopes)

**Verify:** three rows in the token store —

```bash
aws dynamodb scan --table-name slack-knowledge-bot-staging-tokens \
  --projection-expression '#u,#p,updatedAt' \
  --expression-attribute-names '{"#u":"userId","#p":"provider"}' \
  --output json | jq '.Items[] | {provider: .provider.S, updatedAt: .updatedAt.S}'
```

You want one entry each for `google`, `notion`, `atlassian`.

**Can go wrong:** [B.13 OAuth callback returns "unauthenticated"](#b13-oauth-callback-returns-unauthenticated) • [B.14 KMS plaintext > 4096](#b14-kms-plaintext--4096) • [B.15 Atlassian token expired + no refresh](#b15-atlassian-token-expired--no-refresh)

---

## 10. Test queries (2 min)

In Slack, mention or DM the bot. Each of these should ground in exactly one of the three seed pages and cite it by URL:

- `@yourbot what's our PTO policy?` → Notion page
- `@yourbot who's on call this week?` → Confluence page
- `@yourbot what are our Q2 priorities?` → Google Doc

Negative test (nothing seeded for this topic) — should return "I don't have enough information in the documents I can access to answer that":

- `@yourbot what's our laptop refresh policy?`

If any query fails, tail the pod log and grep for the trace ID from the user-facing error message:

```bash
kubectl -n tenants-protohype logs deploy/slack-knowledge-bot --since=5m \
  | grep "<trace-id-from-slack-message>"
```

**Can go wrong:** any entry in Appendix B.

---

# Appendix A: Sample page content

Paste each block verbatim into the matching source. Titles matter (the seed script embeds `title + \n + body`), bodies become the `chunk_text` column in pgvector.

### Notion page — title: `PTO Policy`

```
Full-time employees accrue paid time off at a rate of 1.25 days per month, capped at 15 days per calendar year. Unused days roll over up to a maximum of 5 days into the following year; any balance beyond that is forfeited on January 1st. Time off must be requested in Workday at least two weeks in advance, except in cases of illness or family emergency. Managers approve within three business days. The company additionally observes 10 fixed holidays per year, listed in the employee handbook.
```

### Confluence page — title: `On-call Rotation — Platform Team`

```
Platform engineering on-call runs a weekly rotation, Monday 10am Pacific to Monday 10am Pacific. Primary holds the pager, secondary covers if primary is unreachable within 15 minutes. Severity 1 incidents require acknowledgment within 15 minutes and engagement within 30. Severity 2 is one hour. Hand-off is a synchronous meeting every Monday in the #eng-oncall channel where outgoing reviews open incidents, pending investigations, and any watch items. After-hours pages outside on-call duty are compensated at time-and-a-half.
```

### Google Doc — title: `Q2 2026 Engineering Roadmap`

```
Q2 2026 priorities for Engineering: (1) Ship the knowledge bot to general availability by end of May, with SOC 2 Type II audit fieldwork completed in parallel. (2) Migrate the legacy audit logging system to the new structured event format before June 1st to meet compliance deadlines. (3) Reduce API p95 latency from 3.2 seconds to under 2 seconds through caching, query planning improvements, and a move from t4g.micro to t4g.small database instances. (4) Launch the billing revamp behind a feature flag for 10% of tenants by end of quarter.
```

---

# Appendix B: Troubleshooting

Every non-obvious failure we've seen during this project is indexed here. Symptom → root cause → fix.

### B.1 Ingress / cert-manager TLS not ready

**Symptom:** `curl https://slack-knowledge-bot-staging.example.com/health` fails with a TLS error or connection refused, even though the pod is `Running`.

**Root cause:** the ingress-nginx `Ingress` or its cert-manager-issued certificate hasn't finished provisioning. The ACME HTTP-01/DNS-01 challenge can lag a few minutes, and DNS for the host must resolve to the ingress controller's load balancer first.

**Fix:** check the ingress + certificate status, and that DNS points at the ingress controller:
```bash
kubectl -n tenants-protohype get ingress slack-knowledge-bot
kubectl -n tenants-protohype get certificate
kubectl -n tenants-protohype describe certificate slack-knowledge-bot   # look for Ready=True
```
If the certificate is stuck, inspect its `CertificateRequest`/`Order`/`Challenge` objects (`kubectl -n tenants-protohype get challenge`). Once `Ready=True` and DNS resolves, the `/health` curl succeeds.

---

### B.2 Pod crash-loops at boot with Zod validation

**Symptom:** the Deployment's pod is `CrashLoopBackOff`, exit code 1 on startup. Pod log:
```
Invalid configuration: { <KEY>: { _errors: [ 'Invalid input: expected string, received undefined' ] } }
```

**Root cause:** a required env var or Secrets Manager key isn't reaching the pod. Common cases:
- You pushed code that added a new required env var without also wiring it into `chart/templates/deployment.yaml` (env from chart values) or `chart/templates/externalsecret.yaml` (key from the ESO-synced Secret)
- `put-secret-value` uploaded a JSON missing a key that the ExternalSecret maps into `app-secrets` — the pod env never gets it
- Tokens rotated (Slack reinstall) and the old JSON was reseeded verbatim

**Fix:** cross-reference the `Invalid configuration: { <KEY>: … }` key against `src/config/index.ts` to confirm it's required, then verify the key is present in the secret payload and that ESO synced it into the k8s Secret:
```bash
aws secretsmanager get-secret-value --secret-id slack-knowledge-bot/staging/app-secrets \
  --query 'SecretString' --output text | jq 'keys'

kubectl -n tenants-protohype get secret app-secrets -o jsonpath='{.data}' | jq 'keys'
kubectl -n tenants-protohype describe externalsecret slack-knowledge-bot   # SecretSynced status
```

---

### B.3 Bedrock AccessDenied Marketplace

**Symptom:** Slack reply "I'm having trouble generating an answer right now." Logs:
```
AccessDeniedException: … aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe … to enable access to this model.
```

**Root cause:** The foundation model is served via AWS Marketplace, which requires a first-time subscribe action. The pod's IRSA role intentionally lacks `aws-marketplace:Subscribe` (that would let it subscribe to arbitrary paid models), and the per-region subscribe hasn't been triggered by an admin yet. The cross-region inference profile (`us.anthropic.…`) fans out to **us-east-1, us-east-2, us-west-2** — every region needs the subscribe.

**Fix:** From §3 — AWS Console as admin, switch to each of those regions, Bedrock → Chat → Claude Sonnet 4.6 → send any prompt. For first-time Anthropic use, fill in the use-case form when prompted.

---

### B.4 Bedrock ValidationException on-demand throughput

**Symptom:** Log line:
```
ValidationException: Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.
```

**Root cause:** Claude Sonnet 4.6 is only reachable via a cross-region inference profile; the bare foundation-model ID doesn't work.

**Fix:** `BEDROCK_LLM_MODEL_ID=us.anthropic.claude-sonnet-4-6`. This is already the default in `src/config/index.ts` — if you see this error, check the pod's env for an override (`kubectl -n tenants-protohype exec deploy/slack-knowledge-bot -- printenv BEDROCK_LLM_MODEL_ID`) and remove it from chart values.

---

### B.5 WorkOS 422 empty directory param

**Symptom:** Slack error "Unable to verify your identity." Logs:
```
WorkOS /directory_users 422 … url:"https://api.workos.com/directory_users?directory=&limit=100"
```

**Root cause:** `WORKOS_DIRECTORY_ID` reached the pod as an empty string. It lives in Secrets Manager (`slack-knowledge-bot/{env}/app-secrets`) and flows through ESO → the `app-secrets` k8s Secret → pod env. A missing or blank key in the secret payload injects `""`.

**Fix:** add `"WORKOS_DIRECTORY_ID": "directory_01…"` to the secrets JSON, re-seed (`put-secret-value`), then `kubectl -n tenants-protohype rollout restart deploy/slack-knowledge-bot` so the pod re-reads the resynced Secret.

---

### B.6 Slack invalid_auth after reinstall

**Symptom:**
```
Error: An API error occurred: invalid_auth
code: 'slack_webapi_platform_error'
```
Task stays up (Bolt start is wrapped in try/catch + unhandledRejection guard) but bot doesn't respond.

**Root cause:** Adding a scope + clicking "Reinstall your app" in Slack regenerates the **Bot User OAuth Token** (`xoxb-…`) and may regenerate app-level tokens too. The `xoxb-` / `xapp-` in Secrets Manager is now stale.

**Fix:** re-copy both tokens from the Slack app config (OAuth & Permissions → Bot User OAuth Token; Basic Information → App-Level Tokens), update `/tmp/slack-knowledge-bot-staging-secrets.json`, `put-secret-value`, then `kubectl -n tenants-protohype rollout restart deploy/slack-knowledge-bot`.

**Diagnostic:** curl Slack directly to verify which token is bad —
```bash
BOT=$(aws secretsmanager get-secret-value --secret-id slack-knowledge-bot/staging/app-secrets --query SecretString --output text | jq -r .SLACK_BOT_TOKEN)
curl -sS -X POST -H "Authorization: Bearer $BOT" https://slack.com/api/auth.test | jq .
```

---

### B.7 Socket Mode silent — no events reaching bot

**Symptom:** `@mention` produces no response, no log lines from the task. Tokens are valid (B.6 check passes).

**Root cause:** typically **Event Subscriptions** got disabled or the scope change wasn't saved, OR the bot isn't in the channel you're mentioning from. Slack's reinstall flow sometimes drops the subscription.

**Fix:** api.slack.com/apps → your app →
1. **Socket Mode** → ensure Enable Socket Mode is on
2. **Event Subscriptions** → ensure Enable Events is on AND `app_mention` + `message.im` are in Subscribe to bot events → **Save Changes**
3. Reinstall via the yellow banner if present
4. `/invite @yourbot` in the channel, or DM it directly

---

### B.8 Google "Access blocked — verification"

**Symptom:** Google consent page shows "&lt;your-domain&gt; has not completed the Google verification process", Error 403 `access_denied`.

**Root cause:** The Google OAuth app is in Testing mode. Only pre-approved Test Users can authenticate.

**Fix:** Google Cloud Console → APIs & Services → OAuth consent screen → **Audience** (or Test users) → add your Gmail. Reauthorize.

---

### B.9 Notion token exchange 401

**Symptom:** Browser shows `token_endpoint_error` after Notion consent. Logs:
```
callback provider error, provider:"notion", status:401
```

**Root cause:** Notion's `/v1/oauth/token` requires HTTP Basic auth (`Authorization: Basic base64(client_id:client_secret)`), not body-embedded credentials. Our `slack-knowledge-bot-oauth` package handles this via `tokenAuthStyle: "basic"` on the Notion provider — if you see this after a package upgrade, that flag may have been lost.

**Fix:** re-check `packages/oauth/src/oauth/providers/notion.ts` still declares `tokenAuthStyle: "basic"`. If yes, the client ID/secret in Secrets Manager genuinely mismatch what's in `notion.so/my-integrations` — re-copy and reseed.

---

### B.10 Atlassian "Something went wrong"

**Symptom:** Atlassian's consent page errors out before redirecting back to our callback. Page says "Something went wrong. Information for the owner of <app-name>".

**Root cause:** One of:
1. App Distribution is set to "Development" (blocks install on workspaces other than the dev's own)
2. Callback URL in the Atlassian app doesn't exactly match the one we send (including trailing slash, protocol, etc.)
3. Required scopes are missing from the app config

**Fix:** developer.atlassian.com/console/myapps → your app →
1. **Distribution** → set to **Sharing**
2. **Authorization** → Callback URL is exactly `https://${SLACK_KNOWLEDGE_BOT_STAGING_DOMAIN}/oauth/atlassian/callback`
3. **Permissions** → Confluence API is added with `read:confluence-content.all` + `read:confluence-space.summary`

---

### B.11 pgvector SSL error no_encryption

**Symptom:** Task log:
```
DatabaseError: no pg_hba.conf entry for host "10.0.x.x", user "slack_knowledge_bot_admin", database "slack_knowledge_bot", no encryption
```

**Root cause:** RDS Postgres enforces TLS by default (`rds.force_ssl=1`). A `pg` Pool with no `ssl` config connects plaintext and gets rejected.

**Fix:** already handled in `src/index.ts` — `buildPgSsl()` builds the Pool's `ssl` config, defaulting to TLS verified against the bundled RDS global CA (`PG_SSL_REJECT_UNAUTHORIZED=true`, `PG_SSL_CA_PATH=certs/rds-global-bundle.pem`). If the cert chain can't be validated (e.g. a local Postgres with no trusted chain), set `PG_SSL_REJECT_UNAUTHORIZED=false` to fall back to encrypted-but-unverified. If you see this after a code change, check `buildPgSsl`/`buildRetrievalBackend` in `src/index.ts`.

---

### B.12 Placeholders still in seed script

**Symptom:** Seed script aborts immediately:
```
[seed] failed: Error: seed-demo: placeholder IDs still present — replace REPLACE_WITH_YOUR_* in src/scripts/seed-demo.ts before running.
```

**Root cause:** You haven't plugged your real page IDs into the script yet.

**Fix:** §8c — edit `src/scripts/seed-demo.ts`, replace the four `REPLACE_WITH_YOUR_*` constants, rebuild + redeploy, then re-run the exec-command.

---

### B.13 OAuth callback returns "unauthenticated"

**Symptom:** Browser shows plain `unauthenticated` after provider consent. Logs:
```
resolveUserId: signed /start token did not verify
callback rejected — unauthenticated (resolveUserId returned null)
```

**Root cause:** The signed `?t=…` URL token we DM the user has a short TTL (≈5 min). Clicking a stale DM link fails signature/expiry verification.

**Fix:** `@mention` the bot again to generate a fresh DM link, then click it immediately.

---

### B.14 KMS plaintext > 4096

**Symptom:** OAuth callback 500s with log:
```
callback unexpected error, error: "Value at 'plaintext' failed to satisfy constraint: Member must have length less than or equal to 4096"
```

**Root cause:** KMS's `Encrypt` API has a 4 KB plaintext cap. Atlassian's token response (access + refresh + scopes + accessible_resources) often exceeds that, so encrypting the raw JSON directly fails.

**Fix:** already fixed in `packages/oauth/src/oauth/storage/ddb-kms.ts` — envelope encryption with `GenerateDataKey` + AES-256-GCM. No plaintext size limit. If you see this again, check the storage module hasn't regressed.

Stale tokens from a pre-fix deploy will fail to decrypt with "unsupported envelope version" — resolve by deleting the old row: `aws dynamodb delete-item --table-name slack-knowledge-bot-tokens-{env} --key '{"userId":{"S":"…"},"provider":{"S":"…"}}'`.

---

### B.15 Atlassian token expired + no refresh

**Symptom:** Confluence queries were working immediately after OAuth, then started returning "none accessible" after ~1 hour. Logs:
```
AclProbeError: confluence probe 401
```

**Root cause:** Atlassian issues access tokens with ~1h lifetime. Refresh requires `offline_access`. Our authorize URL always includes `offline_access` in the `scope=` param, but if the user re-OAuthed with an old DM link that was generated before the offline_access fix, or Atlassian didn't honor it for this app type, no refresh token was stored.

**Fix:** check whether the stored grant has a refresh token:
```bash
kubectl -n tenants-protohype exec -it deploy/slack-knowledge-bot -- \
  node -e "const{DDBKmsTokenStorage}=require('slack-knowledge-bot-oauth');const s=new DDBKmsTokenStorage({tableName:process.env.DYNAMODB_TABLE_TOKENS,keyId:process.env.KMS_KEY_ID,region:process.env.AWS_REGION});s.get('<externalUserId>','atlassian').then(g=>console.log(JSON.stringify({hasAccess:!!g?.accessToken,hasRefresh:!!g?.refreshToken,expiresAt:g?.expiresAt?new Date(g.expiresAt*1000).toISOString():null})))"
```
If `hasRefresh` is `false`, delete the row and re-OAuth (trigger with a fresh @mention).

---

### B.16 Confluence probe 400 with fake page IDs

**Symptom:** Every Confluence ACL probe returns 400, all docs redact:
```
AclProbeError: confluence probe 400
```

**Root cause:** Confluence doc IDs in `chunks` must include the Atlassian cloudId: `confluence:<cloudId>:<pageId>`. OAuth 3LO tokens are valid against `api.atlassian.com/ex/confluence/{cloudId}/wiki/…`, not the bare `api.atlassian.com/wiki/…` path. A doc ID like `confluence:page:123` (no cloudId) produces a malformed probe URL → 400.

**Fix:** §8c — set `CONFLUENCE_CLOUD_ID` in the seed script to the UUID from §6's `tenant_info` call, then reseed. The probe builds `https://api.atlassian.com/ex/confluence/<cloudId>/wiki/rest/api/content/<pageId>?expand=version`.

---

### B.17 SQS FIFO MessageDeduplicationId invalid

**Symptom:** Audit emission failing with:
```
InvalidParameterValue: MessageDeduplicationId … for parameter MessageDeduplicationId is invalid.
Reason: MessageDeduplicationId can only include alphanumeric and punctuation characters. 1 to 128 in length.
```

**Root cause:** SQS FIFO caps `MessageDeduplicationId` at 128 characters. Long external user IDs (WorkOS `directory_user_…`) + query hash + timestamp exceed that.

**Fix:** already fixed — `src/audit/audit-logger.ts` hashes the tuple into a 64-char SHA-256 hex digest.

---

### B.18 kubectl exec forbidden

**Symptom:** `kubectl -n tenants-protohype exec -it deploy/slack-knowledge-bot -- …` exits with:
```
Error from server (Forbidden): pods "slack-knowledge-bot-…" is forbidden:
User "…" cannot create resource "pods/exec" in API group "" in the namespace "tenants-protohype"
```

**Root cause:** your kube context maps to a role that lacks `pods/exec` in the tenant namespace. The Platform's RBAC scopes who can shell into tenant pods.

**Fix:** authenticate with a context that has exec rights in `tenants-protohype` (check `kubectl auth can-i create pods/exec -n tenants-protohype`). If you only need read-only data, `kubectl logs` and the AWS CLI (`aws dynamodb …`) don't require exec.

---

### B.19 /slack-knowledge-bot disconnect says "not a valid command"

**Symptom:** Slack replies "fab: Not a valid command" when you type `/slack-knowledge-bot disconnect atlassian`.

**Root cause:** The slash command isn't registered in the Slack app config. The handler is written (`src/slack/disconnect-command.ts`) but registering a slash command requires adding it at api.slack.com/apps → **Slash Commands** → Create New Command. Socket Mode routes it automatically once registered.

**Workaround (no registration needed):** delete the provider's row directly:
```bash
aws dynamodb delete-item --table-name slack-knowledge-bot-staging-tokens \
  --key '{"userId":{"S":"<externalUserId>"},"provider":{"S":"atlassian"}}'
```
Next `@mention` DM'll offer a fresh OAuth link for that provider.

**Proper fix (optional):** api.slack.com/apps → your app → **Slash Commands** → add `/slack-knowledge-bot` → description "Manage your SlackKnowledgeBot account" → Save → Reinstall app.
