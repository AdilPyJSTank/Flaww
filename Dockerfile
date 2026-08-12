# syntax=docker/dockerfile:1
#
# Two stages so the runtime image doesn't carry dev dependencies or the Prisma
# CLI. Smaller image = faster Cloud Run cold start, which matters here because
# the service scales to zero and every Telegram message pays that cost.

FROM node:22-slim AS deps
WORKDIR /app

# openssl is required by Prisma's query engine on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY prisma ./prisma
# Generate against the production dependency tree so the engine binary that
# ends up in the final image is the one the client expects.
RUN npx --yes prisma@6 generate


FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json flaww.config.ts ./
COPY prisma ./prisma
COPY src ./src

# tsx runs the TypeScript directly. For a service this size the ~200ms it adds
# to cold start is a fair trade for not maintaining a build step; swap in a
# real `tsc` build if cold start ever becomes the bottleneck.
RUN npm install --no-save tsx@4

# Cloud Run overrides this; the default keeps `docker run` working locally.
ENV PORT=8080
EXPOSE 8080

# Run as a non-root user — Cloud Run doesn't require it, but a container that
# can't write to its own filesystem is one less thing to think about.
USER node

CMD ["npx", "tsx", "src/index.ts"]
