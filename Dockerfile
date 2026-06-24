# syntax=docker/dockerfile:1.7

FROM node:24.13.0-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS runner

ENV NODE_ENV="production"
ENV PORT="3000"
ENV CIST_HEADLESS="true"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile \
  && pnpm exec playwright install --with-deps chromium

COPY --from=build /app/dist ./dist

RUN mkdir -p .auth .data \
  && chown -R node:node /app /ms-playwright

USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
