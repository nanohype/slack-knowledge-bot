// Required env defaults so config/index.ts Zod parse succeeds inside test runners.
// Real values come from .env at runtime; tests use placeholders.
const defaults: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SIGNING_SECRET: "test-secret",
  SLACK_APP_TOKEN: "xapp-test",
  AWS_REGION: "us-west-2",
  DYNAMODB_TABLE_TOKENS: "test-tokens",
  DYNAMODB_TABLE_AUDIT: "test-audit",
  DYNAMODB_TABLE_IDENTITY_CACHE: "test-identity-cache",
  SQS_AUDIT_QUEUE_URL: "https://sqs.test/queue",
  SQS_AUDIT_DLQ_URL: "https://sqs.test/dlq",
  RETRIEVAL_BACKEND_URL: "",
  KMS_KEY_ID: "arn:aws:kms:us-west-2:000000000000:key/test",
  REDIS_URL: "redis://localhost:6379",
  WORKOS_API_KEY: "sk_test",
  WORKOS_DIRECTORY_ID: "directory_01TEST",
  NOTION_OAUTH_CLIENT_ID: "test",
  NOTION_OAUTH_CLIENT_SECRET: "test",
  CONFLUENCE_OAUTH_CLIENT_ID: "test",
  CONFLUENCE_OAUTH_CLIENT_SECRET: "test",
  GOOGLE_OAUTH_CLIENT_ID: "test",
  GOOGLE_OAUTH_CLIENT_SECRET: "test",
  APP_BASE_URL: "https://test",
  STATE_SIGNING_SECRET: "test-state-signing-secret-at-least-32-bytes-long",
  // A placeholder, and it belongs here rather than in vitest.eval.config.ts
  // precisely because this list is a fallback: the loop below skips any key
  // already set. Vitest's `test.env` is not a fallback — it overwrites
  // process.env unconditionally, so declaring this there would silently
  // discard the endpoint the eval workflow exports and send every model call
  // at a cluster-internal DNS name that does not resolve in CI.
  MODEL_GATEWAY_ENDPOINT: "http://gw.tenants-x.svc.cluster.local:8080",
  NODE_ENV: "test",
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
