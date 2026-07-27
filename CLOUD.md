# Cloud-Only Capabilities PacketAgent Does Not Ship

> **Status: strategic reference, not an active plan.** PacketAgent remains
> self-hosted. This inventory predates the autonomous-worker repositioning and
> may contain time-sensitive competitor examples; it does not override the
> current roadmap or backlog.

PacketAgent is self-hosted. That choice is a hard constraint, not a milestone - every feature listed in this document is structurally easier (or only possible) when a vendor owns the runtime, the network edge, the credentials, and the billing meter. We chose self-host because operators told us they wanted ownership of the source code, the data, the LLM key, and the deploy target more than they wanted a free public URL or a one-click App Store submission. The cost of that choice is real, and this document is where we are honest about it. It also exists so that if we ever build a hosted product ("PacketAgent Cloud") that complements - not replaces - the OSS workbench, we already know which surfaces it would have to own.

Nothing in this document is a roadmap commitment. It is a deferred-features inventory and a strategic reference. The closest self-host equivalent is called out for each capability so operators know what they already have today.

## How to read this document

Each section below covers one capability that a hosted competitor ships and PacketAgent self-host does not. The structure is consistent:

- **The capability.** A plain-language description of what the user experience looks like in a hosted product.
- **Who ships it.** Named competitors that demonstrably have this capability in production.
- **Why it's structurally hosted-only.** The underlying technical and commercial reasons this is hard or impossible to ship in a single-tenant self-hosted binary.
- **What PacketAgent Cloud would need to ship it.** The concrete surfaces, integrations, and operational commitments a hypothetical PacketAgent Cloud product would need to take on.
- **Closest self-host equivalent today.** What PacketAgent _does_ offer in the same problem space, with the explicit tradeoffs called out.

Three things this document is not:

- **It is not a list of bugs.** These are not capabilities we plan to ship in the OSS workbench. They are capabilities that belong to a different product category.
- **It is not a list of weaknesses.** For operators who chose self-host _because_ they wanted ownership, several of these "missing" features are actively desirable to not have (no vendor in the OAuth path, no vendor in the credit metering path, no vendor that can be subpoenaed for your data).
- **It is not exhaustive.** The hosted-builder category will keep adding features. This document covers the seven most-asked-about gaps as of the Fork B positioning decision. We will add to it as patterns crystallize.

---

## 1. Managed deploy with a free public subdomain and auto TLS

**The capability.** A user clicks "Publish" and within seconds gets a working HTTPS URL on a vendor-controlled apex domain (for example `my-app.replit.app`, `my-app.lovable.app`, or `v0.build/...`). The vendor handles DNS, certificate issuance and renewal, edge routing, and the underlying runtime. The user never touches a server.

**Who ships it.** Replit Agents (`*.replit.app`), Lovable (`*.lovable.app`), v0 by Vercel (`v0.build` + Vercel project handoff), Bolt, Base44.

**Why it's structurally hosted-only.** A free public subdomain assumes a vendor-controlled apex domain, shared certificate infrastructure, multi-tenant compute, and an abuse pipeline - surfaces that a single-tenant self-hosted binary does not have:

- A vendor-owned apex DNS zone (the wildcard `*.replit.app` record is registered to Replit, not to each user).
- A wildcard ACME pipeline (or per-subdomain on-demand certificate issuance, which has rate-limit and revocation implications).
- A multi-tenant runtime that can spin up and tear down sandboxes per app, with isolation strong enough that one tenant's app cannot read another tenant's filesystem, network, or environment.
- A per-app reverse-proxy table that routes incoming requests by host header to the right tenant sandbox.
- An abuse / CSAM / phishing review pipeline (any time strangers can publish content under your apex domain, you become responsible for what they publish there).
- A DMCA + content-takedown workflow with legal-team coverage.

**What PacketAgent Cloud would need to ship it.** A vendor-owned apex domain with wildcard TLS (Let's Encrypt or a commercial CA), plus:

- A per-tenant subdomain allocator with collision detection, name squatting protection, and reserved-name lists.
- A multi-tenant runtime - Firecracker, gVisor, Kata Containers, Fly Machines, or Cloud Run - with per-app CPU, memory, and egress caps.
- An edge proxy (Caddy, Traefik, or Cloudflare Workers) keyed by host header, with TLS termination at the edge.
- An abuse reporting endpoint and a content takedown workflow integrated with legal review.
- Per-tenant uptime monitoring and a status-page surface so operators can see when their hosted app is down.

**Closest self-host equivalent today.**

- Publish handoff produces a Docker-Compose-ready bundle under `data/generated-apps/<workspace>/<app>/workspace`.
- Operators run `docker compose up` against their own infrastructure - a VPS, a homelab, a Kubernetes cluster, a behind-the-VPN bare-metal box.
- DNS, TLS, and reverse-proxy are the operator's responsibility. PacketAgent links to reverse-proxy examples for the common case.
- The upside is that the URL, the certificate, and the data all live on infrastructure the operator owns - no vendor can revoke the URL, lose the certificate, or be subpoenaed for the data.

**Why the gap is acceptable for self-host operators.** The kind of operator who chooses self-host usually already has a deploy target. They have an internal Kubernetes cluster, a Fly.io account, a Hetzner VPS, or a behind-the-VPN bare-metal box that exists for reasons unrelated to PacketAgent. The "I clicked a button and got a URL" experience is genuinely useful for a solo founder shipping a marketing site; it is much less useful inside an organization where the deploy target was decided three years ago and the security review for "let a vendor's hosted runtime serve our internal CRM at `crm.vendor.app`" is a non-starter. Self-host meets that operator where they already are.

---

## 2. Hosted browser-agent farm for autonomous QA loops

**The capability.** When the builder finishes writing an app, a hosted fleet of Chromium browsers opens it, runs an end-to-end smoke pass, takes screenshots, files bug reports back into the builder thread, and loops until the app passes. The user does not provision the browser farm and does not pay per browser-minute directly - it is bundled into the subscription.

**Who ships it.** Anything Max (autonomous QA loop with credit-cap circuit breaker), twin.so Web Agent (persistent Chromium sessions that survive across turns and authenticate into third-party apps).

**Why it's structurally hosted-only.** Self-host Playwright is straightforward; self-host _fleets_ of authenticated, long-lived, rate-limited, billable Playwright sessions is not. A hosted browser farm needs:

- A per-tenant browser pool with concurrency caps so one tenant's loop cannot starve everyone else.
- A session store that survives between agent turns - cookies, localStorage, IndexedDB, auth tokens - so the agent does not have to re-log-in on every turn.
- Egress IPs that aren't already blocked by CAPTCHA, WAF, or bot-detection services (most VPS IP ranges are flagged; residential or rotating datacenter egress is a separate procurement problem).
- A screenshot / artifact pipeline with retention windows and per-tenant storage quotas.
- A hard isolation boundary so tenant A's authenticated session cannot leak into tenant B's browser context.
- A credit meter so a runaway loop does not bankrupt the vendor before someone notices.

**What PacketAgent Cloud would need to ship it.**

- A Playwright / Chrome DevTools Protocol pool on top of Browserless, Steel.dev, or a hand-rolled Kubernetes Chromium deployment.
- A per-tenant encrypted session store (cookies + storage state + service-worker registrations).
- Residential or rotating-datacenter egress for sites that block VPS ranges.
- A screenshot store with retention policy, per-tenant quotas, and signed-URL access.
- A credit meter wired into Stripe metered billing (see section 7).
- A circuit breaker that halts the loop at the credit cap and surfaces a clear "we stopped you here" message in the workbench.
- An audit trail per browser session for compliance and dispute resolution.

**Closest self-host equivalent today.**

- PacketAgent ships optional Playwright-backed `browser_goto`, screenshot, and DOM tools (artifacts persisted under `data/artifacts/`).
- The sandbox runtime (`/api/app/sandbox/*`) executes smoke checks against generated apps when `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1` and Docker is available.
- There is no persistent cross-turn browser session, no credit meter, and no farm - the operator runs as many parallel sandboxes as their hardware allows.
- For autonomous QA, operators can wire Playwright into the sandbox and define their own loop with their own bounds; PacketAgent does not impose the loop shape.

**Why the gap is acceptable for self-host operators.** Autonomous QA loops that run for hours and spend hundreds of dollars in browser-minutes and LLM tokens are a hosted-product affordance - they exist because the vendor can amortize idle browser capacity across tenants and because the vendor's pricing model needs the loop to be opaque enough that "the agent worked hard" justifies the bill. Self-host operators usually want the opposite: a deterministic, bounded test run on hardware they control, with the LLM cost visible per-call against their own provider account. The honest answer here is that a self-host operator who wants a continuous autonomous QA loop should wire Playwright + their own LLM key into PacketAgent's existing sandbox surface and set the bounds themselves - not wait for a vendor to make that decision for them.

---

## 3. iOS App Store and Google Play one-click submission

**The capability.** A user describes a mobile app, the builder generates it, and a single button submits a signed binary to App Store Connect and Google Play. The vendor handles signing certificates, provisioning profiles, version bumps, release notes, screenshot generation, and the back-and-forth with Apple / Google reviewers.

**Who ships it.** anything.com (their headline differentiator vs. web-only competitors).

**Why it's structurally hosted-only.** Every component of mobile-app submission is a multi-week integration with a vendor (Apple, Google) that does not offer a clean self-host story:

- A managed macOS build farm. Apple's terms forbid building iOS apps on non-Apple hardware, and macOS-in-the-cloud licensing is restricted to Apple-authorized providers.
- Persistent App Store Connect API keys or Apple ID credentials per tenant, plus App Store Connect team membership management.
- Persistent Google Play Console service-account credentials per tenant.
- A signing key vault per tenant (`.p12` certificates for iOS, Android keystores for Play).
- TestFlight / internal-test distribution for pre-submission review.
- App Store review liaison. Rejections require a human reply with attachments inside App Store Connect; there is no clean API for the back-and-forth.
- Per-app metadata management: screenshots per locale, age rating, content descriptors, export compliance attestations, privacy nutrition labels, in-app purchase declarations.
- A long-lived background worker that can wait days for a review verdict and then resume the publish flow without losing context.

**What PacketAgent Cloud would need to ship it.**

- A managed macOS build farm. MacStadium, AWS EC2 Mac, Scaleway Mac mini, or owned hardware in a colo - none of these are cheap, and the per-build minute cost dominates the unit economics.
- Fastlane (or an equivalent) orchestrating signing, build, upload, and metadata sync, with reproducible build outputs for audit.
- An encrypted per-tenant credential vault for App Store Connect API keys and Play Console service accounts, with rotation and revocation tooling.
- A metadata editor in the workbench covering screenshots, descriptions per locale, age rating, and content descriptors.
- A TestFlight invite manager.
- A review-status webhook listener with retry, an Apple-rejection triage UI, and a notification surface that wakes the operator when Apple replies.
- Per-tenant Apple Developer Program enrollment guidance. Operators have to enroll themselves (the vendor cannot enroll on their behalf for App Store distribution under standard terms), which means the "one-click" promise is always preceded by a multi-week Apple onboarding the vendor does not control.

**Closest self-host equivalent today.**

- PacketAgent does not generate native mobile apps. The generated app target is a React/Vite web bundle.
- Operators wanting mobile reach today wrap the generated web app in Capacitor, Tauri Mobile, or a native WebView; build locally on their own Mac for iOS or any machine for Android; and submit themselves.
- A future agent template could generate the Capacitor wrapper plus a Fastlane configuration, but the build-and-submit step would still happen on the operator's hardware against the operator's own developer accounts.
- For PWA / "install from browser" distribution (which covers most internal-tool use cases), no store submission is needed at all.

**Why the gap is acceptable for self-host operators.** Internal apps and agents - PacketAgent's primary use case - almost never need App Store distribution. They are accessed from a browser on the corporate network, from a PWA installed on the phone home screen, or from a WebView wrapped in a sideloaded enterprise IPA. App Store distribution is essentially a consumer / SMB-marketing affordance, and operators who actually need it usually have a dedicated mobile team and an established Fastlane pipeline. The honest answer is that "publish my internal CRM to the App Store" is not a workflow most self-host operators will ever run; for the small number who do, the existing Capacitor + own-Mac path is the right one.

---

## 4. Hosted OAuth proxy with pre-wired connectors

**The capability.** The builder offers a catalog of 30+ (Replit) to 2,700+ (twin.so) third-party integrations. The user clicks "Connect Slack" and authenticates inside the builder UI; the vendor stores the OAuth refresh token, handles token rotation, and exposes the API to the generated app without the user ever registering an OAuth app, copying a client secret, or hosting a callback URL.

**Who ships it.** Replit Agents (pre-approved integration cards), twin.so (advertised 2,700+ native connectors), Lovable (Supabase, Stripe, Resend pre-wiring).

**Why it's structurally hosted-only.** OAuth providers (Google, Microsoft, Slack, GitHub, Notion, Atlassian, etc.) require a registered OAuth client per _consuming application_, and the registration model is built around a single hosted identity:

- Each OAuth client has a fixed set of callback URLs and a verified domain.
- Sensitive scopes (Gmail read, Drive read/write, Calendar write, Slack files, Microsoft Graph mail) trigger a security review: Google Cloud trust & safety, Microsoft Publisher Verification, Slack App Directory review.
- A vendor amortizes that registration and review cost across every tenant - the vendor's hosted callback URL is the single registered redirect, and the vendor's verified-publisher status unlocks restricted scopes for every tenant.
- A self-host operator would need to register their own OAuth client with every provider they want to use, pass each provider's verification, and host their own callback. That is exactly the friction most operators want to avoid when they ask for "pre-wired connectors."

**What PacketAgent Cloud would need to ship it.**

- A registered OAuth client per provider: Google Workspace Marketplace listing, Microsoft Publisher Verification, Slack App Directory submission, GitHub App registration, Atlassian Connect app, etc.
- Per-tenant token storage with encryption at rest and automatic refresh-token rotation.
- A hosted callback endpoint per provider.
- A connector catalog UI in the workbench, with consent-screen previews and scope descriptions.
- A quota / rate-limit layer per tenant per provider, since one noisy tenant can get the entire shared OAuth client throttled or banned.
- A per-tenant scope-consent audit trail.

**Closest self-host equivalent today.**

- PacketAgent's encrypted secrets vault (AES-256-GCM at rest) stores arbitrary API keys, including OAuth client secrets and refresh tokens that the operator obtains by registering their own OAuth app with each provider.
- Agents can call any HTTP API; there is no allowlist of "approved" providers.
- There is no curated connector catalog, no token-rotation helper, and no vendor-amortized OAuth client - the operator brings their own.
- For providers with a long-lived API-key model (Stripe, OpenAI, Anthropic, many internal APIs), no OAuth round-trip is needed and the secrets vault is the full story.

**Why the gap is acceptable for self-host operators.** A vendor-amortized OAuth client means every PacketAgent Cloud tenant shares the same registered "PacketAgent" OAuth app with each provider - which is convenient but also means every Cloud tenant inherits the vendor's brand on the consent screen ("PacketAgent would like to access your Google account"), the vendor's rate limits, and the vendor's risk profile if the OAuth client gets flagged or revoked. Self-host operators who register their own OAuth client see their _own_ brand on the consent screen, get their own rate limits, and are not exposed to noisy-neighbor revocations. For internal-tool use (the dominant PacketAgent use case), the consent-screen ownership often matters more than the convenience of pre-wiring - IT departments are more comfortable approving an internal-branded OAuth client than a third-party vendor's.

---

## 5. Cross-tenant User Memory layer

**The capability.** A user's preferences, prior project context, naming conventions, and history follow them across workspaces, organizations, and apps. When they start a new project the builder already knows that they prefer Postgres over SQLite, that their company uses `kebab-case` URLs, that their default deploy region is `us-west-2`, and that they have already connected Slack. Memory lives _above_ the workspace, scoped to the user identity.

**Who ships it.** twin.so (explicit User Memory layer above workspace boundary).

**Why it's structurally hosted-only.** Cross-tenant memory needs a vendor-owned identity that survives across tenants - and self-host has no such identity:

- In self-host, the user identity _is_ the workspace user. There is no parent account that owns multiple workspaces, and no global identity provider that spans installations.
- There is no vendor-side database that could hold a memory record keyed by a user identity that spans PacketAgent installations on different operators' servers.
- Even if a user runs two self-hosted PacketAgent instances themselves, they are separate databases on separate servers with separate user IDs; the only way to share state would be a vendor-owned sync layer, which is by definition hosted.
- Cross-tenant memory is also a non-trivial privacy surface - a vendor that holds memory records spanning multiple of a user's workspaces is holding more sensitive context than any individual workspace would, and that demands explicit consent infrastructure that self-host has no use for.

**What PacketAgent Cloud would need to ship it.**

- A vendor-owned identity layer: a Cloud user account that is distinct from workspace accounts and that survives across workspace boundaries.
- A memory store keyed by Cloud user ID, with append-only writes and structured redaction semantics (so the user can delete a specific memory without deleting the surrounding context).
- An explicit consent flow. Memory is privacy-sensitive - the user must opt in to what gets stored, see a real-time view of what is stored, and be able to delete or correct it.
- A retrieval layer that surfaces relevant memories per builder turn, with provenance shown to the user (so they know _why_ the agent is making an assumption).
- A clear boundary between memory (cross-tenant, user-scoped) and workspace context (single-tenant, workspace-scoped), so a workspace admin cannot read another user's cross-workspace memory through the workspace.

**Closest self-host equivalent today.** Per-workspace persistence: every workspace stores its own apps, agents, secrets, audit log, run history, and provider configuration. There is no cross-workspace memory. Operators who want shared context across workspaces today export and re-import agent templates, or run a single shared workspace.

**Why the gap is acceptable for self-host operators.** Cross-tenant memory is a feature of consumer-grade hosted products where one human signs into one vendor account and expects continuity across everything the vendor offers. Self-host operators are usually deploying PacketAgent _inside_ a larger identity boundary - their company's SSO, their VPN, their compliance perimeter - and "memory that follows the user across our self-hosted installs and a vendor's hosted install" actively breaks that boundary. The right primitive for self-host is workspace-scoped memory (which PacketAgent already has) plus exportable agent templates (which PacketAgent already has), not vendor-owned cross-install memory.

---

## 6. Shareable and remixable conversation URLs with public hosting

**The capability.** Every builder conversation has a public URL. Anyone with the link can view the conversation, fork it into their own account, and continue editing - the vendor handles the public-read storage, the fork-on-write semantics, the auth-or-anonymous gating, and the abuse pipeline for public content. This is how v0 chats and Lovable Remix work, and it doubles as the vendor's primary organic-growth loop.

**Who ships it.** v0 by Vercel (chat permalinks under `v0.dev/chat/...`), Lovable Remix (fork-a-public-project), Bolt (shareable project URLs).

**Why it's structurally hosted-only.** Public conversation URLs need a vendor-controlled URL space, a public-read storage layer, a fork-on-write data model, and an abuse pipeline - none of which a self-hosted single-tenant instance has:

- A vendor-controlled URL space. The vendor's domain shows up in the share link, and that _is_ the distribution channel - a self-hosted instance's URL is on the operator's domain and has no growth value.
- A public-read object store for conversation transcripts and generated artifacts, with cache headers and edge distribution.
- A fork-on-write database model: read-only public copy -> writable per-user clone, with attribution preserved.
- Authentication for the fork action: anonymous browse + authenticated remix.
- An abuse / takedown pipeline for public content. Anything users can publish, strangers will eventually use to publish prompt-injection demos, leaked secrets, CSAM, or copyrighted assets.

**What PacketAgent Cloud would need to ship it.**

- A vendor-owned domain for share links. The link _has_ to be on a recognized domain to be shareable - `https://my-vps.example.com/share/abc` is not the same growth channel as `https://packetagent.cloud/share/abc`.
- A public-read transcript store with secret redaction. The share pipeline must scan and strip API keys, internal URLs, customer names, and any other sensitive content - Lovable has had public incidents where leaked secrets ended up in shared transcripts.
- A fork-on-write model that copies the public transcript into the forking user's private workspace, preserving attribution but giving the forker full edit rights.
- Anonymous-browse rate limiting to protect the public-read surface from scrapers.
- A moderation / takedown queue with a clear policy.
- SEO and OpenGraph metadata for shared links (this is where the growth loop actually happens - a shared link rendered as a rich preview in Twitter / LinkedIn / Slack is what drives signups).

**Closest self-host equivalent today.** Operators can export an agent or app workspace and share the bundle through their own channels (git repo, internal wiki, S3 bucket, email). There is no first-class "share this conversation" URL. The closest in-product affordance is the existing `/api/public/share` route for individual artifacts, which an operator can expose if they choose to put their PacketAgent instance behind a public URL - but it is opt-in, scoped, and does not include the fork-on-write growth loop.

**Why the gap is acceptable for self-host operators.** Shareable / remixable conversation URLs are primarily a _growth_ feature - they exist because the vendor wants the share link to be on the vendor's domain so that strangers seeing the link learn about the vendor. That value proposition does not transfer to self-host: an operator sharing a `https://packetagent.internal.example.com/share/abc` link does not benefit anyone except the recipient, and the recipient cannot fork it into "their account" on the vendor's instance because there is no vendor instance. For the legitimate sharing use case (showing a colleague what you built), exporting the workspace bundle through the same channels the team already uses for code review and design review is a better fit than a public URL would be.

---

## 7. Managed credit / billing meter for unbounded QA loops

**The capability.** Long-running autonomous loops (anything Max's continuous QA, agentic refactors, multi-turn browser sessions, parallel code-search agents) are gated by a credit meter the vendor owns. The meter tracks tokens, browser-minutes, sandbox-seconds, and tool calls; it surfaces a real-time spend display, enforces a per-plan cap, and short-circuits the loop when the cap is hit so a runaway agent cannot generate a surprise five-figure bill.

**Who ships it.** anything Max (credit-cap circuit breaker is part of the product), Replit Agents (effort-based billing with daily caps), Lovable (message credits per plan).

**Why it's structurally hosted-only.** The credit meter is fundamentally a billing meter - it exists because of _who is paying_:

- In a hosted product, the vendor is fronting the cost of LLM tokens, browser-minutes, and sandbox compute. The meter exists to recover that cost predictably and to protect the vendor balance sheet from runaway loops.
- In self-host, the operator is the one paying the LLM provider directly. There is no vendor balance sheet to protect, no credit pool to deplete, no vendor-side circuit breaker to flip.
- The closest equivalent for self-host - a _spending_ cap on the operator's own LLM key - belongs to the LLM provider (Anthropic, OpenAI) and the operator's own cost-monitoring tools, not to PacketAgent.
- Building a PacketAgent-side meter that does not back onto vendor billing would be a UX surface only; the operator could trivially bypass it by raising the cap or hitting the LLM provider directly. The honest place for the cap is at the LLM provider, where it has teeth.

**What PacketAgent Cloud would need to ship it.**

- A metered billing integration (Stripe metered billing or equivalent), with per-event usage records that can be replayed if Stripe loses an event.
- Per-tenant credit pools with daily and monthly caps, plus per-workflow caps for high-risk loops.
- Real-time spend tracking surfaced in the workbench, so the user can see the meter move as the agent works.
- A circuit breaker wired into every long-running loop - LLM call, browser session, sandbox exec - that halts cleanly when the cap is hit and produces a resumable state.
- An overage / top-up flow with explicit user confirmation (never silent overage).
- An admin override for trusted tenants who need to raise their own cap without contacting support.
- Per-event provenance so credit consumption is auditable and disputable when the user disagrees with the bill.

**Closest self-host equivalent today.**

- Operators bring their own LLM API key. Spend is governed by whatever caps the operator sets at the LLM provider (Anthropic and OpenAI both expose monthly spend caps and per-key budgets).
- PacketAgent records provider calls in `provider-calls` history for local cost visibility and can surface per-workspace token usage.
- PacketAgent does not act as the spending governor - the LLM provider is. For operators who want hard local caps, the recommended pattern is to set a low monthly budget on the API key itself and let the provider reject calls when it is exhausted.
- For local Ollama installs, "spend" is wall-clock time on the operator's hardware; the only cap that matters is the per-call timeout, which is configurable in the workbench.

**Why the gap is acceptable for self-host operators.** A managed credit meter is the vendor's way of saying "you don't know how much this will cost, but trust us - the meter will stop in time." Self-host operators usually want the opposite: full visibility into per-call token spend against their own LLM account, and the ability to set the budget cap _at the LLM provider_ where it cannot be bypassed by a runaway loop or a misconfigured workflow. The Anthropic and OpenAI spend caps are honest hard limits - when the budget is hit, the provider rejects calls and the loop stops. That is a stronger guarantee than a vendor-managed meter that lives in the same product as the agent it is supposed to govern.

---

## Patterns we are watching but have not committed to

The hosted-builder category is moving quickly. Several emerging patterns are too new to inventory at the level of detail above, but they share the same structural property - they are easier (or only possible) when a vendor owns the runtime. We are watching them and may add them as full sections if they become as established as the seven above.

- **Hosted vector / RAG stores keyed by tenant.** Several competitors are bundling a managed embedding + retrieval layer so the user does not provision Pinecone / Weaviate / pgvector themselves. The self-host equivalent is the operator standing up pgvector or running embeddings against their own provider key.
- **Hosted background-job runtime for generated apps.** Competitors that own the runtime can offer "schedule this generated function to run nightly" without the user provisioning anything. PacketAgent already ships a jobs queue with five-field cron for the _workbench_; what it does not offer is a vendor-hosted jobs runtime for the _generated app_ - the operator runs the generated app's jobs themselves.
- **Hosted observability for generated apps.** Vendor-owned logs, traces, error tracking, and uptime monitoring for the generated apps. The self-host equivalent is the operator pointing their generated app at their own Sentry / Datadog / Grafana / Loki stack.
- **Hosted feature flags and A/B testing for generated apps.** Same pattern: vendor-owned LaunchDarkly-equivalent for hosted apps; self-host operators wire their own flag provider.
- **Hosted email / SMS / push notification delivery.** Vendor-owned Resend / Twilio / OneSignal proxy that does not require the operator to register their own sender domain. Self-host operators register their own.

The common thread: every one of these is easier when the vendor amortizes a third-party integration (Pinecone, Sentry, Resend) across all tenants. None of them are _technically_ impossible in self-host; they are just less convenient, and the convenience tax of registering one's own accounts with each provider is the same tradeoff that applies to OAuth (section 4).

---

## If we ever build PacketAgent Cloud

A hypothetical PacketAgent Cloud would need to own three surfaces that self-host intentionally does not:

- **Vendor-owned identity, auth, and billing.** A Cloud account that spans workspaces, a metered billing integration (Stripe metered or equivalent), and a per-tenant credit / quota layer that can short-circuit runaway loops.
- **A multi-tenant deploy pipeline.** A vendor-owned apex domain, wildcard TLS, a tenant-isolated runtime (Firecracker / Fly Machines / Cloud Run), an edge proxy keyed by host header, and an abuse / takedown workflow.
- **A vendor-amortized integration plane.** Pre-registered OAuth clients per provider with verified-publisher status, a hosted callback endpoint per provider, a connector catalog, and per-tenant token storage with automatic rotation.

PacketAgent Cloud would coexist with the self-host OSS workbench, not replace it:

- Self-host stays the default and stays MIT licensed. No feature is removed from self-host to push users toward Cloud.
- Cloud would be a separate product for operators who explicitly want to trade ownership for convenience - solo founders shipping marketing sites, teams that do not have an existing deploy target, users who need pre-wired OAuth more than they need OAuth-client ownership.
- Anything we ship in Cloud that can sensibly land in self-host (better generated-app exports, better local Compose tooling, better artifact bundles, better reverse-proxy guidance) lands in self-host too.
- Anything that is _structurally_ Cloud-only - the items in this document - stays Cloud-only and is not back-ported as a half-implementation in self-host. A half-implemented multi-tenant runtime, OAuth proxy, or credit meter in a single-tenant binary is worse than not having it at all.
