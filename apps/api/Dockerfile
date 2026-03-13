# =============================================================================
# Stage 1: Base image with pnpm enabled
# =============================================================================
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# =============================================================================
# Stage 2: Install ALL dependencies (dev + prod) for building
# =============================================================================
FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/config/package.json ./packages/config/
RUN pnpm install --frozen-lockfile

# =============================================================================
# Stage 3: Build the API and its workspace dependencies
# =============================================================================
FROM base AS builder
WORKDIR /app
COPY --from=deps /app ./
COPY . .
RUN pnpm turbo run build --filter=@wahooks/api

# =============================================================================
# Stage 4: Production runner — minimal image with only compiled output
# =============================================================================
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy workspace config needed by pnpm install
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# Copy compiled outputs and package.jsons for the API and its runtime deps
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/

COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=builder /app/packages/db/scripts/migrate.cjs ./packages/db/scripts/migrate.cjs

COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/

# Config package ships raw files (tsconfig, eslint) — only needed at build time,
# but pnpm workspace resolution requires its package.json to exist.
COPY --from=builder /app/packages/config/package.json ./packages/config/

RUN pnpm install --frozen-lockfile --prod

EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
