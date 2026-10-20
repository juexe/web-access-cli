# syntax=docker/dockerfile:1

# Build stage: pinned pnpm, frozen lockfile, then production-only dependencies.
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.16.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build
RUN pnpm prune --prod

# Runtime stage: only built output, schemas, production dependencies, licenses.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/schemas ./schemas
COPY --chown=1000:1000 LICENSE THIRD_PARTY_NOTICES.md ./
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "dist/server.js"]
