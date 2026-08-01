# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build:web
RUN npm run build:server
RUN npm run typecheck
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8484 \
    PACKETAGENT_STORE=sqlite \
    PACKETAGENT_DB_PATH=/app/data/packetagent.sqlite \
    PACKETAGENT_SANDBOX_DRIVER=docker \
    PACKETAGENT_ARTIFACT_SERVING_ENABLED=false

WORKDIR /app
RUN groupadd --system packetagent \
  && useradd --system --gid packetagent --home-dir /app packetagent \
  && mkdir -p /app/data/artifacts \
  && chown -R packetagent:packetagent /app

COPY --from=build --chown=packetagent:packetagent /app/package.json /app/package-lock.json ./
COPY --from=build --chown=packetagent:packetagent /app/node_modules ./node_modules
COPY --from=build --chown=packetagent:packetagent /app/src ./src
COPY --from=build --chown=packetagent:packetagent /app/dist ./dist
COPY --from=build --chown=packetagent:packetagent /app/web/dist ./web/dist

USER packetagent
EXPOSE 8484
VOLUME ["/app/data"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
