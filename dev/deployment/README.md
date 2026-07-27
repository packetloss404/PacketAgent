# PacketAgent Deployment Guide

Operator-facing reference for self-hosting PacketAgent. Use these pages when you are running PacketAgent yourself: configuring storage, hardening the public surface, wiring the deployment to your monitoring and log pipeline, or sending invitation email through your own provider.

If you only want to evaluate PacketAgent locally, the defaults in the project root README are enough. Come back here when you are ready to put the app behind a real proxy, point it at durable storage, ship logs to a SIEM, or invite real users.

## Pages

- [persistence](./persistence.md) - pick a store (local JSON, single-node SQLite, managed Postgres), set up backups and migrations, understand single-node vs multi-writer limits.
- [security](./security.md) - same-origin and CSRF enforcement, auth and invitation rate limits, trusted-proxy configuration, session cookie behavior, token redaction in DTOs/exports/access logs, and the secrets vault.
- [operations](./operations.md) - health probes, the admin operations status and health endpoints, alert rules and webhook delivery, scheduler leader election for multi-process deployments, and access-log shipping.
- [email](./email.md) - invitation email modes, the outbound webhook contract, retry and dead-letter behavior, and the inbound provider-status webhook plus reconciliation CLI.

## When you need this

- **Standing up production.** Read [persistence](./persistence.md) and [security](./security.md) first. They cover the env vars you cannot leave at defaults.
- **Wiring monitoring or log shipping.** [operations](./operations.md) lists the probe paths, the admin-scoped status/health endpoints, and ships ready-to-tweak shipper configs under `examples/access-log-shipping/`.
- **Sending invitations to real users.** [email](./email.md) explains the webhook handoff PacketAgent uses to delegate delivery to your provider, and the inbound webhook your provider should call back to mark messages delivered, bounced, or dropped.
- **Putting the app behind multiple processes or hosts.** [persistence](./persistence.md) explains why a shared SQLite file is unsupported and points you at managed Postgres; [operations](./operations.md) covers the scheduler leader-election gate so two processes do not both run the same job.

## Example configs

The `examples/` directory ships drop-in starter configs:

- `examples/access-log-shipping/` - Vector, Fluent Bit, and Promtail configs that tail PacketAgent's access log and forward parsed JSON to your SIEM.
- `examples/proxy-access-log-redaction/` - nginx, Caddy, and Apache snippets that strip token-bearing path segments from proxy access logs before disk write.

Treat them as starting points; tune them to your proxy version, log shipper, and downstream SIEM.
