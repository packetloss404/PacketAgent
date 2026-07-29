# Generated-preview origin proxy examples

PacketAgent serves the workbench and generated previews from one backend
process but requires two browser origins:

- `PACKETAGENT_APP_ORIGIN=https://packetagent.example.com`
- `PACKETAGENT_PREVIEW_ORIGIN=https://preview.packetagent.example.com`

Use different hostnames, not only different ports. Browser cookies are scoped
by hostname and path, but not by port. PacketAgent refuses production startup
when the configured origins use the same hostname or are not HTTPS.

The primary virtual host rejects generated preview documents and runtime API
routes. The preview virtual host allows only the generated preview,
`preview-session`, and generated runtime API paths. PacketAgent repeats both
checks at the application boundary, so the proxy rule is defense in depth.

The normal PacketAgent session and CSRF cookies are host-only and therefore
are not sent to the preview hostname. The preview capability arrives in a URL
fragment, is exchanged on the preview origin, and becomes a Secure, HttpOnly,
SameSite=None, partitioned cookie scoped to one generated app path. The
partition permits an interactive preview iframe without turning the cookie
into a general third-party credential. Fragments are not part of HTTP requests
and do not appear in ordinary proxy access logs.

When `PACKETAGENT_TRUST_PROXY=true`, strip client-supplied forwarding headers
at the edge and set `X-Forwarded-Host`, `X-Forwarded-Proto`, and
`X-Forwarded-For` yourself, as shown in the nginx example.

After configuring the environment, run:

```bash
npm run verify:preview-isolation
```

The verifier uses isolated temporary state and proves the route split,
fragment exchange, cookie attributes, CSP, read-only share scope, and
interactive bridge scope.
