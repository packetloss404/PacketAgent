import { readFileSync } from "node:fs";
import type { GeneratedAppRuntimeModel } from "./generated-app-runtime.js";
import type { GeneratedAppPublishArtifactFile } from "./generated-app-publish-integrity.js";

export const GENERATED_APP_PUBLISH_COMPOSE_FILE = "docker-compose.publish.yml";
export const GENERATED_APP_PUBLISH_DOCKERFILE = "Dockerfile.publish";
export const GENERATED_APP_PUBLISH_SERVER_FILE = "runtime/server.mjs";
export const GENERATED_APP_PUBLISH_MODEL_FILE = "runtime/runtime-model.json";
export const GENERATED_APP_PUBLISH_RUNBOOK_FILE = "RUNBOOK.md";
export const GENERATED_APP_PUBLISH_CADDY_EXAMPLE_FILE = "deploy/Caddyfile.example";
export const GENERATED_APP_PUBLISH_NGINX_EXAMPLE_FILE = "deploy/nginx.generated-app.conf.example";
export const GENERATED_APP_PUBLISH_TAILSCALE_GUIDE_FILE = "deploy/TAILSCALE.md";

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
    {
      path: GENERATED_APP_PUBLISH_CADDY_EXAMPLE_FILE,
      content: caddyExampleContent(),
      kind: "config",
      description: "Caddy automatic-HTTPS reverse-proxy example.",
      mediaType: "text/plain; charset=utf-8",
    },
    {
      path: GENERATED_APP_PUBLISH_NGINX_EXAMPLE_FILE,
      content: nginxExampleContent(),
      kind: "config",
      description: "nginx TLS reverse-proxy example.",
      mediaType: "text/plain; charset=utf-8",
    },
    {
      path: GENERATED_APP_PUBLISH_TAILSCALE_GUIDE_FILE,
      content: tailscaleGuideContent(),
      kind: "config",
      description: "Private Tailscale Serve and optional public Funnel instructions.",
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
      - "\${PACKETAGENT_GENERATED_APP_BIND_ADDRESS:-127.0.0.1}:\${PACKETAGENT_GENERATED_APP_PORT:-8787}:8080"
    volumes:
      - generated-app-data:/app/data
    user: node
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
    ulimits:
      nproc: 128
      nofile:
        soft: 512
        hard: 512
    init: true
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
host port. The container listens on port 8080. Compose binds the host port to
\`127.0.0.1\` by default so a firewall cannot be accidentally bypassed. Set
\`PACKETAGENT_GENERATED_APP_BIND_ADDRESS=0.0.0.0\` only when direct LAN exposure
is deliberate and protected.

## Reverse proxy, VPN, and reachability

- \`deploy/Caddyfile.example\` terminates public TLS with Caddy.
- \`deploy/nginx.generated-app.conf.example\` shows an nginx TLS proxy with
  explicit certificate placeholders.
- \`deploy/TAILSCALE.md\` keeps the app private to a tailnet with Tailscale
  Serve and separately explains the public Funnel option.

After DNS/TLS or VPN routing is configured, verify the exact app and checkpoint
from the PacketAgent repository:

\`\`\`bash
npm run verify:generated-app-reachability -- <publish-directory> https://app.example.com
\`\`\`

Use the final HTTPS origin. The verifier refuses redirects, insecure non-local
HTTP, wrong app/checkpoint identity, non-HTML roots, and bounded DNS, TCP/TLS,
or HTTP failures. PacketAgent does not create DNS records or certificates.

## Stop

\`\`\`bash
docker compose -f docker-compose.publish.yml down --remove-orphans
\`\`\`

The \`generated-app-data\` volume keeps SQLite data across ordinary restarts.
Add \`--volumes\` only when you intentionally want to erase that local data.

## Offline backup and restore

Stop the service first. Closing the last SQLite connection checkpoints WAL
content into \`runtime.sqlite\`, so the backup is one consistent database file.
Keep backups outside this sealed publish directory:

\`\`\`bash
mkdir -p ../generated-app-backups
docker compose -f docker-compose.publish.yml stop generated-app
docker compose -f docker-compose.publish.yml run --rm --no-deps \\
  --volume "$PWD/../generated-app-backups:/backup" generated-app \\
  node --input-type=module --eval \\
  "import { copyFileSync } from 'node:fs'; copyFileSync('/app/data/runtime.sqlite', '/backup/${input.checkpointId}-runtime.sqlite')"
docker compose -f docker-compose.publish.yml start --wait
\`\`\`

To restore that exact checkpoint, stop the service, copy the selected backup
back into the named volume, restart, and rerun reachability verification:

\`\`\`bash
docker compose -f docker-compose.publish.yml stop generated-app
docker compose -f docker-compose.publish.yml run --rm --no-deps \\
  --volume "$PWD/../generated-app-backups:/backup:ro" generated-app \\
  node --input-type=module --eval \\
  "import { copyFileSync } from 'node:fs'; copyFileSync('/backup/${input.checkpointId}-runtime.sqlite', '/app/data/runtime.sqlite')"
docker compose -f docker-compose.publish.yml start --wait
\`\`\`

The Docker certification command runs this same stopped-service backup/restore
round trip against a temporary external directory and removes its test data.

## Runtime and schema-change truth

- The final image contains built static assets, the small Node runtime, runtime
  config, and the generated schema model. It does not contain source
  dependencies or the PacketAgent server.
- Image build may access the package registry only during dependency install.
  The Vite compile step runs with Docker build networking disabled.
- The container runs as the unprivileged \`node\` user with a read-only root
  filesystem. Only the named SQLite volume and bounded \`/tmp\` tmpfs are writable.
- The declared policy is \`reset-and-reseed\`: ordinary same-schema restarts
  preserve records, while a schema-signature change clears and reseeds this
  app's SQLite records. Back up the volume before replacing the package with a
  schema-changing checkpoint. Automatic data-preserving migration is not
  implemented or claimed.
- The default bridge network permits outbound traffic. Connector-specific
  egress restrictions are enforced by PacketAgent's Worker runtime, not this
  standalone generated-app compose package.
`;
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function caddyExampleContent(): string {
  return `# Set PACKETAGENT_GENERATED_APP_HOSTNAME to a DNS name that resolves
# to this host. Caddy obtains and renews public certificates when the host is
# reachable on ports 80 and 443.
{$PACKETAGENT_GENERATED_APP_HOSTNAME} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:{$PACKETAGENT_GENERATED_APP_PORT:8787} {
    health_uri /health/ready
    health_interval 30s
    health_timeout 5s
  }
}
`;
}

function nginxExampleContent(): string {
  return `# Replace app.example.com and both certificate paths. Keep the
# generated-app Compose port bound to 127.0.0.1.
server {
  listen 80;
  listen [::]:80;
  server_name app.example.com;
  return 308 https://$host$request_uri;
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name app.example.com;

  ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:8787;
    proxy_redirect off;
  }
}
`;
}

function tailscaleGuideContent(): string {
  return `# Tailscale access

The generated app binds to \`127.0.0.1:8787\` by default. Keep that loopback
binding and let Tailscale terminate HTTPS.

## Private tailnet access

\`\`\`bash
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
\`\`\`

Tailscale prints the private \`https://<device>.<tailnet>.ts.net\` origin.
Verify that final origin with \`verify:generated-app-reachability\`. Remove the
Serve configuration with:

\`\`\`bash
tailscale serve reset
\`\`\`

## Optional public Funnel

Funnel is public internet exposure, not private VPN access. It requires
tailnet-policy approval and supported Tailscale configuration:

\`\`\`bash
tailscale funnel --bg http://127.0.0.1:8787
tailscale funnel status
\`\`\`

Review the printed public HTTPS origin and run the same reachability verifier.
Disable it with \`tailscale funnel reset\`. PacketAgent does not enable Serve
or Funnel automatically.

Current command reference:
https://tailscale.com/docs/reference/tailscale-cli/serve
`;
}
