# Security Policy

## Reporting a Vulnerability

PacketAgent's public source repository is
[packetloss404/PacketAgent](https://github.com/packetloss404/PacketAgent).
Report suspected vulnerabilities privately through that repository's Security
tab when private vulnerability reporting is available, or through an existing
trusted private channel to the project owner. Do not place exploit details,
credentials, or reproduction artifacts in a public task, discussion, or issue.
Public GitHub issues are for non-sensitive defects only.

Include the affected version or commit, a concise impact summary, reproduction steps, and any relevant deployment assumptions. We aim to acknowledge reports within 72 hours.

## Supported Versions

PacketAgent is pre-1.0 and has no tagged PacketAgent release yet. Security
fixes target the active development branch until a release policy is
established.

## Production Baseline

Self-hosted production deployments should set:

- `NODE_ENV=production`
- `MASTER_KEY` to a long deployment-specific secret
- `PACKETAGENT_RATE_LIMIT_KEY_SALT` to a deployment-specific secret
- `PACKETAGENT_SANDBOX_DRIVER=docker`
- `PACKETAGENT_ARTIFACT_SERVING_ENABLED=false` unless generated artifacts are intentionally public

The native sandbox driver runs commands on the host and is blocked in production unless `PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX=true` is set for a trusted development environment.

Do not publish `.env`, database files, `data/artifacts/`, logs, or workspace exports. These may contain bearer material, encrypted secret blobs, user content, or operational metadata.
