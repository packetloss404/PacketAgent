import { readFileSync } from "node:fs";
import type { GeneratedAppRuntimeModel } from "./generated-app-runtime.js";
import type { GeneratedAppPublishArtifactFile } from "./generated-app-publish-integrity.js";

export const GENERATED_APP_PUBLISH_COMPOSE_FILE = "docker-compose.publish.yml";
export const GENERATED_APP_PUBLISH_DOCKERFILE = "Dockerfile.publish";
export const GENERATED_APP_PUBLISH_SERVER_FILE = "runtime/server.mjs";
export const GENERATED_APP_PUBLISH_MODEL_FILE = "runtime/runtime-model.json";
export const GENERATED_APP_PUBLISH_RUNBOOK_FILE = "RUNBOOK.md";

export interface GeneratedAppPublishPackageInput {
  workspaceId: string;
  appId: string;
  checkpointId: string;
  appName: string;
  model: GeneratedAppRuntimeModel;
}

export function buildGeneratedAppPublishPackageFiles(
  input: GeneratedAppPublishPackageInput,
): GeneratedAppPublishArtifactFile[] {
  return [
    {
      path: GENERATED_APP_PUBLISH_DOCKERFILE,
      content: dockerfileContent(),
      kind: "config",
      description: "Multi-stage generated-app image with an offline Vite build step.",
      mediaType: "text/plain; charset=utf-8",
    },
    {
      path: GENERATED_APP_PUBLISH_COMPOSE_FILE,
      content: generatedAppDockerComposeYaml(),
      kind: "config",
      description: "Single-service local Docker Compose runtime for this generated app.",
      mediaType: "application/yaml; charset=utf-8",
    },
    {
      path: ".dockerignore",
      content: dockerignoreContent(),
      kind: "config",
      description: "Bounded Docker build context exclusions.",
      mediaType: "text/plain; charset=utf-8",
    },
    {
      path: GENERATED_APP_PUBLISH_SERVER_FILE,
      content: standaloneServerContent(),
      kind: "source",
      description: "Dependency-free static, health, and SQLite CRUD runtime.",
      mediaType: "text/javascript; charset=utf-8",
    },
    {
      path: GENERATED_APP_PUBLISH_MODEL_FILE,
      content: jsonContent(input.model),
      kind: "config",
      description: "Generated schema and seed model consumed by the standalone runtime.",
      mediaType: "application/json; charset=utf-8",
    },
    {
      path: GENERATED_APP_PUBLISH_RUNBOOK_FILE,
      content: runbookContent(input),
      kind: "config",
      description: "Bounded local start, probe, stop, persistence, and migration runbook.",
      mediaType: "text/markdown; charset=utf-8",
    },
  ];
}

export function generatedAppDockerComposeYaml(): string {
  return `services:
  generated-app:
    build:
      context: .
      dockerfile: Dockerfile.publish
    environment:
      NODE_ENV: production
      PORT: "8080"
    ports:
      - "\${PACKETAGENT_GENERATED_APP_PORT:-8787}:8080"
    volumes:
      - generated-app-data:/app/data
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 128
    cpus: 1.0
    mem_limit: 512m
    restart: unless-stopped
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch('http://127.0.0.1:8080/health/ready').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 10s

volumes:
  generated-app-data:
`;
}

export function generatedAppPublishServiceNames(): string[] {
  return ["generated-app"];
}

function dockerfileContent(): string {
  return `FROM node:22-bookworm-slim AS build

WORKDIR /build/bundle
COPY bundle/package*.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY bundle/ ./
RUN --network=none ./node_modules/.bin/vite build --manifest

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \\
    HOST=0.0.0.0 \\
    PORT=8080 \\
    PACKETAGENT_GENERATED_APP_STATIC_ROOT=/app/static \\
    PACKETAGENT_GENERATED_APP_DATA_ROOT=/app/data \\
    PACKETAGENT_GENERATED_APP_CONFIG_PATH=/app/runtime/runtime-config.json \\
    PACKETAGENT_GENERATED_APP_MODEL_PATH=/app/runtime/runtime-model.json

WORKDIR /app
COPY --from=build --chown=node:node /build/bundle/dist/ /app/static/
COPY --chown=node:node runtime/ /app/runtime/
COPY --chown=node:node runtime-config.json /app/runtime/runtime-config.json
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \\
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "/app/runtime/server.mjs"]
`;
}

function dockerignoreContent(): string {
  return `*
!.dockerignore
!Dockerfile.publish
!bundle
!bundle/**
!runtime
!runtime/**
!runtime-config.json
`;
}

function standaloneServerContent(): string {
  return readFileSync(
    new URL("./generated-app-publish-runtime/server.mjs", import.meta.url),
    "utf8",
  );
}

function runbookContent(input: GeneratedAppPublishPackageInput): string {
  return `# ${input.appName} local publish runbook

This directory is a standalone PacketAgent-generated app package for app
\`${input.appId}\`, workspace \`${input.workspaceId}\`, checkpoint
\`${input.checkpointId}\`. It does not start the PacketAgent control plane.

## Start and verify

\`\`\`bash
docker compose -f docker-compose.publish.yml config --quiet
docker compose -f docker-compose.publish.yml up --build --wait --wait-timeout 180
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/
\`\`\`

Set \`PACKETAGENT_GENERATED_APP_PORT\` before \`up\` to choose another loopback
host port. The container listens on port 8080.

## Stop

\`\`\`bash
docker compose -f docker-compose.publish.yml down --remove-orphans
\`\`\`

The \`generated-app-data\` volume keeps SQLite data across ordinary restarts.
Add \`--volumes\` only when you intentionally want to erase that local data.

## Runtime and migration truth

- The final image contains built static assets, the small Node runtime, runtime
  config, and the generated schema model. It does not contain source
  dependencies or the PacketAgent server.
- Image build may access the package registry only during dependency install.
  The Vite compile step runs with Docker build networking disabled.
- The container runs as the unprivileged \`node\` user with a read-only root
  filesystem. Only the named SQLite volume and bounded \`/tmp\` tmpfs are writable.
- A schema-signature change currently clears and reseeds this app's SQLite
  records. Export or back up the volume before replacing the package with a
  schema-changing checkpoint. Additive, data-preserving migrations remain an
  explicit backlog item.
- The default bridge network permits outbound traffic. Connector-specific
  egress restrictions are enforced by PacketAgent's Worker runtime, not this
  standalone generated-app compose package.
`;
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
