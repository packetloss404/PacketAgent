# R1 dependency advisory audit

Last updated: 2026-07-29.

This is the deliberate dependency disposition required by
[`R1`](../BACKLOG.md#r1---repository-health-and-historical-finding-re-audit).
It records current registry results and reachability; `BACKLOG.md` remains the
implementation ledger.

## Result

The 2026-07-29 baseline contained 11 advisories in the full tree (2 low,
1 moderate, 6 high, 2 critical) and 5 in the production tree (1 low,
1 moderate, 3 high). Targeted non-major upgrades and one compatible transitive
override reduced both audits to 2 high package findings representing one
unreachable advisory. There are no known critical, moderate, or low findings
in the installed tree.

No forced audit fix or unrelated major upgrade was used.

## Remediation

| Ownership          | Package             | Installed decision | Disposition                                                                                                                                                                    |
| ------------------ | ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct runtime     | `hono`              | `4.12.32`          | Upgraded within major; closes the reported routing, cookie, and Windows static-path advisories.                                                                                |
| Direct runtime     | `@hono/node-server` | `2.0.12`           | Upgraded within major; closes the reported Windows static-path and aborted-WebSocket advisories.                                                                               |
| Direct runtime     | `esbuild`           | `0.27.2` exact     | Makes PacketAgent's preview-runtime import explicit instead of relying on a transitive hoist; an override keeps Vite and `tsx` on the same version outside the affected range. |
| Direct runtime     | `react-router-dom`  | `7.18.2` exact     | Uses the newest available 7.x release. The remaining advisory is evaluated below. Exact pin prevents an unreviewed router change during this disposition window.               |
| Direct development | `concurrently`      | `9.2.4`            | Upgraded within major; removes the vulnerable `shell-quote` tree.                                                                                                              |
| Direct development | `postcss`           | `8.5.25`           | Upgraded within major; closes the source-map arbitrary-read advisory.                                                                                                          |
| Direct development | `vite`              | `7.3.6`            | Upgraded within major; closes the reported Vite Windows development-server findings.                                                                                           |
| Transitive         | `@babel/core`       | `7.29.7`           | Safe lockfile refresh closes the source-map arbitrary-read advisory.                                                                                                           |
| Transitive         | `brace-expansion`   | `5.0.8`            | Safe lockfile refresh closes the expansion denial-of-service advisories.                                                                                                       |

## Accepted current advisory

`npm audit` reports `react-router` and its direct parent
`react-router-dom` separately, so the metadata count is 2 high package
findings. Both point to the same RSC-mode CSRF advisory affecting
`react-router >=7.12.0`.

PacketAgent uses React Router as a browser-side `BrowserRouter` navigation
library. It does not enable React Server Components, React Router framework
mode, server actions, or React Router request handlers; Hono owns the server
boundary. The vulnerable RSC action-execution path is therefore not reachable
in the shipped architecture.

Downgrading to `7.11.0`, the registry's automated suggestion for that single
advisory, reintroduces a larger set of open-redirect, XSS, deserialization,
route-matching denial-of-service, SSR, and RSC advisories that affect versions
through `7.17.0`. The deliberate decision is to retain `7.18.2`, keep the
exact pin, and upgrade when the registry publishes a release outside the
remaining RSC advisory range.

Re-audit this exception whenever React Router changes, PacketAgent adopts an
SSR/RSC framework mode, or a patched release becomes available.

## Reproduction

```bash
npm audit
npm audit --omit=dev
npm ls @hono/node-server hono react-router-dom react-router concurrently postcss vite esbuild @babel/core brace-expansion --depth=2
```

Expected audit metadata at this checkpoint:

- full tree: 0 low, 0 moderate, 2 high, 0 critical;
- production tree: 0 low, 0 moderate, 2 high, 0 critical; and
- the two high package entries resolve to the single unreachable React Router
  RSC advisory described above.
