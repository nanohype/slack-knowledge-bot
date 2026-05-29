FROM node:24-alpine AS builder
WORKDIR /app

# Build the almanac-oauth workspace first — almanac depends on it via
# `file:./packages/oauth` and needs its dist/ at install time.
COPY packages/oauth/package.json packages/oauth/package-lock.json packages/oauth/tsconfig.json ./packages/oauth/
RUN cd packages/oauth && npm ci
COPY packages/oauth/src ./packages/oauth/src
RUN cd packages/oauth && npm run build

# Install and build almanac against the just-built local package.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S almanac && adduser -u 1001 -S almanac -G almanac

# Runtime copy of the local package (package.json + dist) — npm ci in the
# runner resolves `almanac-oauth` against this path.
COPY --from=builder /app/packages/oauth/package.json ./packages/oauth/
COPY --from=builder /app/packages/oauth/dist ./packages/oauth/dist

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER almanac

EXPOSE 3001

# OTel auto-instrumentation: the --require hook loads SDK + instrumentations before
# user code, so http/fetch/aws-sdk/pg/etc. are traced automatically. Manual spans
# for business-logic milestones (see src/context.ts) are created alongside.
# OTLP target is the cluster OTel Collector at
# otel-collector.observability.svc.cluster.local:4318 (set via OTEL_EXPORTER_OTLP_ENDPOINT in the chart).
ENV NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
