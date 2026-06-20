# certs/

## `rds-global-bundle.pem`

Amazon RDS / Aurora global certificate-authority bundle. Used to verify the
Aurora Serverless v2 server certificate when the app opens its Postgres
(pgvector) connection, so the DB link is authenticated-encrypted rather than
merely encrypted (`src/config/index.ts` → `PG_SSL_CA_PATH`, consumed in
`src/index.ts` / `src/scripts/seed-demo.ts`).

- **Source:** <https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem>
- **Committed** (not fetched at build time) for reproducible builds; the bundle
  is published by AWS for redistribution.
- **Refresh:** re-download from the URL above when AWS rotates the CA (the
  bundle aggregates all regional RDS CAs). No code change needed — the path is
  stable.

To opt out of verification on a local/dev Postgres with no trusted chain, set
`PG_SSL_REJECT_UNAUTHORIZED=false`.
