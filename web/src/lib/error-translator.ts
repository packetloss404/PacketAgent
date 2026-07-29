/**
 * Translates raw error messages from the AI builder pipeline into
 * non-technical, actionable copy for chat-thread rendering.
 *
 * Order matters: more specific rules win over broader ones. The first match
 * wins, so put narrow patterns (rate-limit/429, ECONNREFUSED) above wider ones
 * (network, unauthorized) when patterns overlap.
 */

export interface FriendlyError {
  /** One-line headline, sentence case, no trailing punctuation. */
  title: string;
  /** 1–2 sentences explaining what most likely went wrong. */
  body: string;
  /** What to try next, written as an action the user can take. */
  suggestion: string;
  /** Original error message — surfaced via a "Details" disclosure. */
  technical?: string;
  /** Whether a "Try again" affordance makes sense for this error. */
  retryable: boolean;
}

interface Rule {
  test: RegExp;
  build: (raw: string) => Omit<FriendlyError, "technical">;
}

const RULES: Rule[] = [
  // Quota / billing first — providers often return HTTP 429 for billing
  // exhaustion, so we route those to "Out of credits" rather than rate-limit
  // when the message mentions quota/credit/billing.
  {
    test: /quota|insufficient.*credit|billing/i,
    build: () => ({
      title: "Out of credits",
      body: "Your provider account is out of credits or quota.",
      suggestion: "Top up your account, or switch providers via Admin → Integrations.",
      retryable: false,
    }),
  },
  {
    test: /rate.?limit|\b429\b/i,
    build: () => ({
      title: "AI provider is busy",
      body: "Your provider is over its rate limit for the moment.",
      suggestion: "Wait a minute, or switch providers via Admin → Integrations.",
      retryable: true,
    }),
  },
  // Connection errors before generic "unauthorized" because some stacks emit
  // "ECONNREFUSED: unauthorized to connect" or similar mixed strings.
  {
    test: /ECONNREFUSED|ENOTFOUND|network/i,
    build: () => ({
      title: "Can't reach the AI",
      body: "Network connection to the provider failed.",
      suggestion: "Check your internet, or for local LLMs make sure Ollama/vLLM is running.",
      retryable: true,
    }),
  },
  {
    test: /timed? out|timeout/i,
    build: () => ({
      title: "Took too long",
      body: "The AI took longer than expected to respond.",
      suggestion: "Try again — this is usually transient.",
      retryable: true,
    }),
  },
  // "No provider" before auth because "No provider registered: invalid API key
  // configured" should route to the provider-setup hint, not the auth hint.
  {
    test: /no provider|no AI|provider not registered/i,
    build: () => ({
      title: "No AI provider set up",
      body: "No provider key is configured yet.",
      suggestion: "Set ANTHROPIC_API_KEY (or another) in your .env file, then restart.",
      retryable: false,
    }),
  },
  {
    test: /\b401\b|\b403\b|unauthor|invalid.*key|API key/i,
    build: () => ({
      title: "API key not accepted",
      body: "The provider rejected the key it received.",
      suggestion: "Check your key in Admin → Integrations or your .env file.",
      retryable: false,
    }),
  },
  {
    test: /file.*too large|context.*length/i,
    build: () => ({
      title: "App is getting too big",
      body: "The AI couldn't fit the whole app in one response.",
      suggestion: "Iterate in smaller steps, or upgrade your provider preset to Smart.",
      retryable: true,
    }),
  },
  // TS errors come before "parse" because "TS1005: parse error" should route
  // to compile-errors, not malformed-JSON.
  {
    test: /typescript.*error|\bTS\d+\b/i,
    build: () => ({
      title: "Generated code has errors",
      body: "The AI wrote code that doesn't compile.",
      suggestion: "Click 'Fix these errors' or describe what's wrong in chat.",
      retryable: true,
    }),
  },
  {
    test: /parse|malformed JSON|tool_use/i,
    build: () => ({
      title: "AI response was unclear",
      body: "The AI returned something I couldn't read.",
      suggestion: "Try again — sometimes a re-prompt is all it takes.",
      retryable: true,
    }),
  },
];

const FALLBACK: Omit<FriendlyError, "technical"> = {
  title: "Something went wrong",
  body: "An unexpected error happened.",
  suggestion: "Try again, or describe what you're seeing to debug.",
  retryable: true,
};

export function translateError(raw: string | Error): FriendlyError {
  const message =
    raw instanceof Error ? raw.message || raw.name || "Unknown error" : (raw ?? "").toString();

  const trimmed = message.trim();
  const technical = trimmed.length > 0 ? trimmed : undefined;

  for (const rule of RULES) {
    if (rule.test.test(trimmed)) {
      return { ...rule.build(trimmed), technical };
    }
  }

  return { ...FALLBACK, technical };
}
