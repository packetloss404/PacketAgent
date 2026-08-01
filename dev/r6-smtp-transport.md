# R6.1 vault-backed SMTP transport

Status: implemented 2026-07-29. `BACKLOG.md` remains the authoritative loop
ledger.

## Outcome

`email_send` now has a production default SMTP transport. Interactive Agent
runs may configure it with `SMTP_*` process settings. Autonomous Workers use
only an opaque, immutable-version-declared `vault:` reference whose credential
kind is `smtp_config`; the sender, destination server, TLS mode, and optional
authentication are resolved inside the allowed handler immediately before
transport creation.

The Worker path preserves the runtime invariants:

- recipient authorization is recorded before credential resolution;
- denied calls do not resolve credentials or create a transport;
- the encrypted credential record and workspace export contain no plaintext;
- every DNS answer must be public and the connection uses a previously
  validated pinned address;
- implicit TLS or mandatory STARTTLS is required, certificate validation stays
  enabled, and TLS 1.2 is the minimum;
- the sender is bound to the vault record rather than Worker-authored input;
- files and URLs cannot be loaded by the mail composer;
- address, header, body, credential, timeout, and result fields are bounded;
- cancellation closes the transport exactly once; and
- tool output, errors, events, and verifier output contain no SMTP password,
  username, host, message body, or recipient plaintext beyond the already
  policy-authorized call record.

Worker browser and SQL execution remain fail-closed because hardened
Worker-specific drivers are not shipped. R6.1 does not broaden those
boundaries or create an automatic follow-on gate.

## Credential contract

Create a workspace Worker credential with kind `smtp_config` and an opaque
reference such as `vault:smtp-primary`. Its encrypted value is strict JSON:

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "secure": false,
  "requireTls": true,
  "from": "PacketAgent <noreply@example.com>",
  "user": "smtp-user",
  "pass": "replace-with-the-real-secret"
}
```

Only those seven fields are accepted. `host`, `port`, and `from` are required.
`user` and `pass` must be supplied together. `secure: true` selects implicit
TLS, normally on port 465. Otherwise `requireTls` must remain true so a server
that cannot negotiate STARTTLS is rejected.

The immutable Worker version must declare the reference and grant
`email_send`, verb `SEND`, for the permitted `mailto:` resources. Worker tool
input supplies `credentialRef` but cannot supply `from`.

## Implementation seams

- `src/workers/smtp.ts` owns the transport boundary and Nodemailer adapter.
- `src/workers/network.ts` exports the shared public-address validation and
  pinning primitive used by HTTP and SMTP.
- `src/tools/email-sql.ts` owns strict message/config parsing, policy-visible
  recipient resources, vault-only Worker dispatch, legacy Agent environment
  compatibility, and redacted results.
- `src/workers/runtime-services.ts` and `src/workers/runtime/adapters.ts` bind
  the SMTP port into canonical Worker execution.
- `src/smtp-verify-cli.ts` is the deterministic certification executable.

## Research and decisions

- Nodemailer's SMTP transport automatically upgrades with STARTTLS when
  available and exposes `requireTLS` to fail when that upgrade is unavailable.
  PacketAgent sets both the transport and message-level file/URL access
  prohibitions described by the official transport and message documentation:
  [SMTP transport](https://nodemailer.com/smtp),
  [transport security options](https://nodemailer.com/transports), and
  [message configuration](https://nodemailer.com/message).
- RFC 8314 recommends TLS for message submission and reserves port 465 for
  implicit TLS. PacketAgent supports implicit TLS and mandatory STARTTLS but
  deliberately refuses cleartext fallback:
  [RFC 8314](https://www.rfc-editor.org/rfc/rfc8314.html).
- Certificate verification keeps the original DNS hostname as the TLS server
  name while the TCP connection uses the validated address. For IP-literal
  configuration no artificial DNS server name is added. This follows Node's
  TLS certificate and `servername` behavior:
  [Node.js TLS documentation](https://nodejs.org/api/tls.html).

## Verification

Run:

```bash
npm run verify:smtp
```

The command uses an encrypted in-memory credential and deterministic fake
transport. It proves ciphertext-only storage, public-address pinning,
certificate-validated TLS, credential-bound sender identity, denial before
credential access, allow-before-secret-before-I/O ordering, secret-free
results, and the default Agent transport path. It performs no live DNS lookup
and sends no email.

Focused coverage also exercises blocked/private targets, mixed address
resolution, header injection, invalid credential fields and types, cleartext
configuration, sender spoofing, abort cleanup, export redaction, runtime
service binding, registry bypass prevention, and allowed/denied policy order.
