import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderRouter } from "../providers/router.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderName,
  ProviderStreamChunk,
} from "../providers/types.js";
import {
  authorAndValidateAppViaLLM,
  authorAppViaLLM,
  isSafePath,
  MAX_FILES_PER_WRITE_CHUNK,
  parsePlan,
  type CodegenProgressEvent,
  type ResolvedPrompts,
} from "./llm-author.js";
import type { ValidateOptions, ValidationResult } from "./validate.js";

// ---------------------------------------------------------------------------
// Mock provider scaffolding
// ---------------------------------------------------------------------------
//
// Each scripted "turn" is a sequence of stream chunks that the mock provider
// will replay on the corresponding `stream()` call. Tests build a list of
// turns and pass them in; the orchestrator runs the plan phase (turn 0,
// possibly turn 1 on retry) and then the write phase (next turn).
// ---------------------------------------------------------------------------

type ScriptedChunk = ProviderStreamChunk;
type ScriptedTurn = ScriptedChunk[];

interface MockProviderOptions {
  name?: ProviderName;
  turns: ScriptedTurn[];
  /** Throw from `stream()` itself on the Nth call. */
  throwAtCall?: number;
}

class MockProvider implements LLMProvider {
  name: ProviderName;
  private turns: ScriptedTurn[];
  private throwAtCall: number | undefined;
  public calls: Array<{
    tools: string[];
    messages: ProviderCallOptions["messages"];
    model: string;
  }> = [];

  constructor(opts: MockProviderOptions) {
    this.name = opts.name ?? "stub";
    this.turns = opts.turns;
    this.throwAtCall = opts.throwAtCall;
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    return {
      content: "",
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      model: opts.model,
      providerName: this.name,
    };
  }

  stream(opts: ProviderCallOptions): AsyncIterable<ProviderStreamChunk> {
    const callIndex = this.calls.length;
    this.calls.push({
      tools: (opts.tools ?? []).map((t) => t.name),
      messages: opts.messages,
      model: opts.model,
    });
    if (this.throwAtCall === callIndex) {
      throw new Error("mock provider exploded");
    }
    const turn = this.turns[callIndex] ?? [];
    async function* gen() {
      for (const chunk of turn) yield chunk;
    }
    return gen();
  }

  async models(): Promise<string[]> {
    return [];
  }
}

function makeRouterWithProvider(provider: MockProvider): ProviderRouter {
  const router = new ProviderRouter({
    "code.generation": { provider: provider.name, model: "mock-model" },
  });
  router.register(provider.name, provider);
  return router;
}

function fixedPrompts(): ResolvedPrompts {
  return {
    systemPrompt: "SYS",
    planUserPrompt: (goal: string) => `PLAN: ${goal}`,
    writeUserPrompt: (plan: string) => `WRITE: ${plan}`,
  };
}

function planJson(plan: Array<{ path: string; purpose: string }>): string {
  return "Here is the plan:\n\n```json\n" + JSON.stringify(plan) + "\n```";
}

// ---------------------------------------------------------------------------
// Original env capture so tests don't mutate provider resolution globally.
// ---------------------------------------------------------------------------

const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

async function withFakeAnthropicKey<T>(fn: () => T | Promise<T>): Promise<T> {
  process.env.ANTHROPIC_API_KEY = "test";
  try {
    return await fn();
  } finally {
    if (ORIGINAL_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
  }
}

// ---------------------------------------------------------------------------
// parsePlan + isSafePath unit smoke
// ---------------------------------------------------------------------------

test("parsePlan: accepts fenced JSON block with {path, purpose} entries", () => {
  const blob =
    "I'll create three files.\n\n```json\n" +
    JSON.stringify([
      { path: "src/App.tsx", purpose: "root" },
      { path: "src/main.tsx", purpose: "entry" },
    ]) +
    "\n```";
  const parsed = parsePlan(blob);
  assert.ok(parsed);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.path, "src/App.tsx");
});

test("parsePlan: returns null when nothing parses", () => {
  assert.equal(parsePlan("no plan here"), null);
  assert.equal(parsePlan("```json\n{not valid json\n```"), null);
});

test("isSafePath: rejects absolute paths, .. and empty input", () => {
  assert.equal(isSafePath("src/App.tsx"), true);
  assert.equal(isSafePath("a/b/c.ts"), true);
  assert.equal(isSafePath(""), false);
  assert.equal(isSafePath("/etc/passwd"), false);
  assert.equal(isSafePath("C:/Windows/system32"), false);
  assert.equal(isSafePath("../escape"), false);
  assert.equal(isSafePath("src/../../escape"), false);
});

test("isSafePath: rejects the hardened validator's vectors (NUL/ADS/reserved/trailing-dot)", () => {
  // These are the previously-missed cases now covered because isSafePath
  // delegates to the shared hardened validateWorkspacePath().
  assert.equal(isSafePath("src/App\0.tsx"), false, "NUL byte");
  assert.equal(isSafePath("foo/bar/../../../etc/passwd"), false, "post-normalize ..");
  assert.equal(isSafePath("src/CON.tsx"), false, "Windows reserved name");
  assert.equal(isSafePath("nul"), false, "bare Windows reserved name");
  assert.equal(isSafePath("notes.txt:hidden.exe"), false, "NTFS ADS via ':'");
  assert.equal(isSafePath("src/app.tsx."), false, "trailing dot aliasing");
  assert.equal(isSafePath("src/app.tsx "), false, "trailing whitespace aliasing");
  assert.equal(isSafePath("\\\\server\\share\\f.ts"), false, "UNC path");
});

// ---------------------------------------------------------------------------
// authorAppViaLLM: happy path
// ---------------------------------------------------------------------------

test("authorAppViaLLM: plan phase emits prose then write phase yields files", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = [
      { path: "src/App.tsx", purpose: "root component" },
      { path: "src/main.tsx", purpose: "entry point" },
    ];
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        // Plan phase: stream prose containing a JSON block.
        [
          { delta: "Planning... " },
          { delta: planJson(plan) },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        // Write phase: stream a tiny prose line then two tool calls.
        [
          { delta: "Writing files." },
          {
            toolCall: {
              id: "t1",
              name: "write_file",
              input: { path: "src/App.tsx", content: "export default function App() {}\n" },
            },
          },
          {
            toolCall: {
              id: "t2",
              name: "write_file",
              input: { path: "src/main.tsx", content: "import App from './App'\n" },
            },
          },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
      ],
    });
    const router = makeRouterWithProvider(provider);

    const emitted: string[] = [];
    const result = await authorAppViaLLM(
      "build a counter",
      {
        workspaceId: "w",
        preset: "fast",
        router,
        resolvePrompts: fixedPrompts,
      },
      (chunk) => {
        emitted.push(chunk);
      },
    );

    assert.ok(result, "expected non-null result");
    assert.equal(result.source, "llm");
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0]?.path, "src/App.tsx");
    assert.equal(result.files[1]?.path, "src/main.tsx");
    assert.match(result.summary, /LLM-authored/);
    // Prose from both phases reached the emit callback.
    const joined = emitted.join("");
    assert.match(joined, /Planning\.\.\./);
    assert.match(joined, /Writing files\./);
    // Write-phase call included the write_file tool definition.
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(provider.calls[1]?.tools, ["write_file"]);
  });
});

// ---------------------------------------------------------------------------
// authorAppViaLLM: failure modes
// ---------------------------------------------------------------------------

test("authorAppViaLLM: returns null when the plan phase errors", async () => {
  await withFakeAnthropicKey(async () => {
    const provider = new MockProvider({
      name: "anthropic",
      turns: [[{ error: "boom" }]],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "anything",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    assert.equal(result, null);
  });
});

test("authorAppViaLLM: returns null when zero write_file calls are emitted", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = [{ path: "src/App.tsx", purpose: "root" }];
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        [
          { delta: planJson(plan) },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        // Write phase: prose only, no tool calls.
        [
          { delta: "I'll think about it." },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
      ],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "build something",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    assert.equal(result, null);
  });
});

test("authorAppViaLLM: invalid paths are skipped, not aborted", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = [
      { path: "src/App.tsx", purpose: "root" },
      { path: "../escape.ts", purpose: "should be rejected" },
    ];
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        [
          { delta: planJson(plan) },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        [
          {
            toolCall: {
              id: "ok",
              name: "write_file",
              input: { path: "src/App.tsx", content: "// ok\n" },
            },
          },
          {
            toolCall: {
              id: "bad",
              name: "write_file",
              input: { path: "../escape.ts", content: "// nope\n" },
            },
          },
          {
            toolCall: {
              id: "abs",
              name: "write_file",
              input: { path: "/etc/passwd", content: "// nope\n" },
            },
          },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
      ],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "build app",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    assert.ok(result);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.path, "src/App.tsx");
  });
});

test("authorAppViaLLM: write path rejects hardened-validator vectors via write_file", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = [{ path: "src/App.tsx", purpose: "root" }];
    // Previously-missed traversal vectors the inline placeholder accepted.
    const unsafePaths = [
      "src/App\0.tsx", // NUL byte
      "foo/../../../etc/passwd", // post-normalize ..
      "src/CON.tsx", // Windows reserved device name
      "notes.txt:hidden.exe", // NTFS alternate data stream
      "src/app.tsx.", // trailing-dot aliasing
    ];
    const unsafeCalls: ScriptedChunk[] = unsafePaths.map((p, idx) => ({
      toolCall: {
        id: `bad-${idx}`,
        name: "write_file",
        input: { path: p, content: "// nope\n" },
      },
    }));
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        [
          { delta: planJson(plan) },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        [
          {
            toolCall: {
              id: "ok",
              name: "write_file",
              input: { path: "src/App.tsx", content: "// ok\n" },
            },
          },
          ...unsafeCalls,
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
      ],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "build app",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    assert.ok(result);
    // Only the single safe file survives; every unsafe vector is dropped.
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.path, "src/App.tsx");
  });
});

test("authorAppViaLLM: retries once when the plan is unparseable, returns null after second failure", async () => {
  await withFakeAnthropicKey(async () => {
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        // First plan attempt: prose with no JSON.
        [
          { delta: "Hmm, here is a plan in plain words." },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        // Retry attempt: still no JSON.
        [
          { delta: "Still not JSON." },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
      ],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "build app",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    assert.equal(result, null);
    // Should have attempted the plan phase twice (no write phase).
    assert.equal(provider.calls.length, 2);
    // Neither call included the write_file tool.
    assert.deepEqual(provider.calls[0]?.tools, []);
    assert.deepEqual(provider.calls[1]?.tools, []);
  });
});

// ---------------------------------------------------------------------------
// authorAppViaLLM: chunked write phase for large plans (>10 files)
// ---------------------------------------------------------------------------

function makePlan(count: number): Array<{ path: string; purpose: string }> {
  const out: Array<{ path: string; purpose: string }> = [];
  for (let i = 0; i < count; i++) {
    out.push({ path: `src/file${i + 1}.ts`, purpose: `purpose ${i + 1}` });
  }
  return out;
}

function writeCallsForPaths(paths: string[]): ScriptedTurn {
  const chunks: ScriptedChunk[] = paths.map((p, idx) => ({
    toolCall: {
      id: `t-${p}-${idx}`,
      name: "write_file",
      input: { path: p, content: `// ${p}\n` },
    },
  }));
  chunks.push({
    done: true,
    usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
  });
  return chunks;
}

test("authorAppViaLLM: 10-file plan uses single write round (no chunking)", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = makePlan(10);
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        // Plan phase.
        [
          { delta: planJson(plan) },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        // Single write round emitting all 10 files.
        writeCallsForPaths(plan.map((p) => p.path)),
      ],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "build app",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    assert.ok(result);
    assert.equal(result.files.length, 10);
    // 1 plan call + 1 write call = 2 total.
    assert.equal(provider.calls.length, 2);
    // Sanity check that the constant is what the test assumes.
    assert.equal(MAX_FILES_PER_WRITE_CHUNK, 8);
    // The single write call carries the write_file tool.
    assert.deepEqual(provider.calls[1]?.tools, ["write_file"]);
    // Files preserve plan order.
    for (let i = 0; i < 10; i++) {
      assert.equal(result.files[i]?.path, plan[i]?.path);
    }
  });
});

test("authorAppViaLLM: 15-file plan chunks the write phase into two rounds (8 + 7)", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = makePlan(15);
    const firstChunkPaths = plan.slice(0, 8).map((p) => p.path);
    const secondChunkPaths = plan.slice(8, 15).map((p) => p.path);
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        // Plan phase.
        [
          { delta: planJson(plan) },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        // Write round 1: 8 files.
        writeCallsForPaths(firstChunkPaths),
        // Write round 2: 7 files.
        writeCallsForPaths(secondChunkPaths),
      ],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "build big app",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    assert.ok(result);
    assert.equal(result.files.length, 15);
    // 1 plan call + 2 write calls = 3 total.
    assert.equal(provider.calls.length, 3);
    // Both write calls carried the write_file tool.
    assert.deepEqual(provider.calls[1]?.tools, ["write_file"]);
    assert.deepEqual(provider.calls[2]?.tools, ["write_file"]);
    // Combined output preserves plan order.
    for (let i = 0; i < 15; i++) {
      assert.equal(result.files[i]?.path, plan[i]?.path);
    }
    // Round 1 user prompt mentions only the first chunk's paths.
    const round1User = provider.calls[1]?.messages.find((m) => m.role === "user");
    assert.ok(round1User);
    const round1Text =
      typeof round1User.content === "string"
        ? round1User.content
        : JSON.stringify(round1User.content);
    for (const p of firstChunkPaths) {
      assert.match(round1Text, new RegExp(p.replace(/\./g, "\\.")));
    }
    // And does NOT mention paths from the second chunk's exclusive set.
    for (const p of secondChunkPaths) {
      assert.ok(!round1Text.includes(p), `round 1 prompt should not mention chunk-2 path ${p}`);
    }
  });
});

test("authorAppViaLLM: chunked write stops early when a chunk emits zero files (partial result)", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = makePlan(15);
    const firstChunkPaths = plan.slice(0, 8).map((p) => p.path);
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        // Plan phase.
        [
          { delta: planJson(plan) },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
        // Write round 1: 8 files.
        writeCallsForPaths(firstChunkPaths),
        // Write round 2: prose only, no tool calls.
        [
          { delta: "I have nothing further." },
          { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
        ],
      ],
    });
    const router = makeRouterWithProvider(provider);
    const result = await authorAppViaLLM(
      "build app",
      { workspaceId: "w", preset: "fast", router, resolvePrompts: fixedPrompts },
      () => {},
    );
    // Orchestrator returns the partial result it accumulated before bail-out.
    assert.ok(result, "expected non-null result with partial files");
    assert.equal(result.files.length, 8);
    for (let i = 0; i < 8; i++) {
      assert.equal(result.files[i]?.path, plan[i]?.path);
    }
    // Plan + 2 write rounds were attempted, then it stopped (no 4th call).
    assert.equal(provider.calls.length, 3);
  });
});

test("authorAppViaLLM: preset routes through the registered provider", async () => {
  // Resolve `local` preset → only ollama is acceptable. Register ollama as
  // the mock and confirm the orchestrator calls it (rather than failing or
  // hitting a different provider).
  const provider = new MockProvider({
    name: "ollama",
    turns: [
      [
        {
          delta: planJson([{ path: "src/App.tsx", purpose: "root" }]),
        },
        { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
      ],
      [
        {
          toolCall: {
            id: "t1",
            name: "write_file",
            input: { path: "src/App.tsx", content: "// ok\n" },
          },
        },
        { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
      ],
    ],
  });
  const router = makeRouterWithProvider(provider);
  const result = await authorAppViaLLM(
    "local app",
    { workspaceId: "w", preset: "local", router, resolvePrompts: fixedPrompts },
    () => {},
  );
  assert.ok(result);
  assert.equal(provider.calls[0]?.model, "qwen2.5-coder:32b");
});

test("authorAppViaLLM: local provider policy writes one file per turn", async () => {
  const plan = makePlan(3);
  const provider = new MockProvider({
    name: "ollama",
    turns: [
      [
        { delta: planJson(plan) },
        { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } },
      ],
      writeCallsForPaths([plan[0]!.path]),
      writeCallsForPaths([plan[1]!.path]),
      writeCallsForPaths([plan[2]!.path]),
    ],
  });
  const router = makeRouterWithProvider(provider);
  const result = await authorAppViaLLM(
    "local three-file app",
    { workspaceId: "w", preset: "local", router, resolvePrompts: fixedPrompts },
    () => {},
  );

  assert.ok(result);
  assert.equal(result.files.length, 3);
  assert.equal(provider.calls.length, 4);
  for (let index = 0; index < plan.length; index++) {
    const prompt = provider.calls[index + 1]?.messages.find(
      (message) => message.role === "user",
    )?.content;
    assert.match(String(prompt), new RegExp(plan[index]!.path.replace(/\./g, "\\.")));
    for (const other of plan.filter((_, otherIndex) => otherIndex !== index)) {
      assert.equal(String(prompt).includes(other.path), false);
    }
  }
});

test("authorAndValidateAppViaLLM: repairs once after validation failure", async () => {
  await withFakeAnthropicKey(async () => {
    const initialPlan = [{ path: "src/App.tsx", purpose: "broken root" }];
    const repairedPlan = [{ path: "src/App.tsx", purpose: "fixed root" }];
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        [{ delta: planJson(initialPlan) }],
        [
          {
            toolCall: {
              id: "w1",
              name: "write_file",
              input: {
                path: "src/App.tsx",
                content: "export default function App(){ return missing; }\n",
              },
            },
          },
        ],
        [{ delta: planJson(repairedPlan) }],
        [
          {
            toolCall: {
              id: "w2",
              name: "write_file",
              input: {
                path: "src/App.tsx",
                content: "export default function App(){ return null; }\n",
              },
            },
          },
        ],
      ],
    });
    const validations: ValidationResult[] = [
      {
        ok: false,
        source: "real",
        errors: [
          {
            file: "src/App.tsx",
            line: 1,
            message: "Cannot find name 'missing'.",
            severity: "error",
            phase: "typecheck",
          },
        ],
        warnings: [],
        durationMs: 12,
        phases: { typecheck: "failed", build: "skipped" },
      },
      {
        ok: true,
        source: "real",
        errors: [],
        warnings: [],
        durationMs: 20,
        phases: { typecheck: "passed", build: "passed" },
      },
    ];
    const validateFn = async (
      _files: Array<{ path: string; content: string }>,
      _options: ValidateOptions = {},
    ) => validations.shift() ?? validations[validations.length - 1]!;

    const emitted: string[] = [];
    const progress: CodegenProgressEvent[] = [];
    const result = await authorAndValidateAppViaLLM(
      "Build a tiny app.",
      {
        workspaceId: "ws",
        router: makeRouterWithProvider(provider),
        resolvePrompts: fixedPrompts,
        validateFn,
        onProgress: (event) => {
          progress.push(event);
        },
      },
      (chunk) => {
        emitted.push(chunk);
      },
    );

    assert.ok(result);
    assert.equal(result!.repairAttempts, 1);
    assert.equal(result!.validation.ok, true);
    assert.match(result!.files[0]!.content, /return null/);
    assert.ok(emitted.some((chunk) => chunk.includes("Trying repair pass 1 of 2")));
    assert.ok(
      progress.some(
        (event) =>
          event.attempt === 0 &&
          event.phase === "plan" &&
          event.path === "src/App.tsx" &&
          event.status === "completed",
      ),
    );
    assert.ok(
      progress.some(
        (event) =>
          event.attempt === 0 &&
          event.phase === "validate" &&
          event.path === "src/App.tsx" &&
          event.status === "failed" &&
          event.errorCount === 1,
      ),
    );
    assert.ok(
      progress.some(
        (event) =>
          event.attempt === 1 &&
          event.phase === "write" &&
          event.path === "src/App.tsx" &&
          event.status === "completed",
      ),
    );
    assert.ok(
      progress.some(
        (event) =>
          event.attempt === 1 &&
          event.phase === "validate" &&
          event.path === "src/App.tsx" &&
          event.status === "completed",
      ),
    );
  });
});

test("authorAndValidateAppViaLLM: reports skipped validation without claiming success", async () => {
  const progress: CodegenProgressEvent[] = [];
  const result = await authorAndValidateAppViaLLM(
    "Build a tiny app.",
    {
      workspaceId: "ws",
      authorFn: async () => ({
        files: [
          { path: "src/App.tsx", content: "export default function App() { return null; }\n" },
        ],
        summary: "tiny app",
        source: "llm",
      }),
      validateFn: async () => ({
        ok: true,
        source: "skipped",
        errors: [],
        warnings: [],
        durationMs: 0,
        phases: { typecheck: "skipped", build: "skipped" },
      }),
      onProgress: (event) => {
        progress.push(event);
      },
    },
    () => {},
  );

  assert.ok(result);
  assert.equal(result.validation.source, "skipped");
  assert.ok(
    progress.some(
      (event) =>
        event.phase === "validate" && event.path === "src/App.tsx" && event.status === "skipped",
    ),
  );
  assert.equal(
    progress.some(
      (event) =>
        event.phase === "validate" && event.path === "src/App.tsx" && event.status === "completed",
    ),
    false,
  );
});

test("authorAndValidateAppViaLLM: stops on repeated validation signature", async () => {
  await withFakeAnthropicKey(async () => {
    const plan = [{ path: "src/App.tsx", purpose: "root" }];
    const provider = new MockProvider({
      name: "anthropic",
      turns: [
        [{ delta: planJson(plan) }],
        [
          {
            toolCall: {
              id: "w1",
              name: "write_file",
              input: { path: "src/App.tsx", content: "broken one" },
            },
          },
        ],
        [{ delta: planJson(plan) }],
        [
          {
            toolCall: {
              id: "w2",
              name: "write_file",
              input: { path: "src/App.tsx", content: "broken two" },
            },
          },
        ],
      ],
    });
    const repeated: ValidationResult = {
      ok: false,
      source: "real",
      errors: [
        {
          file: "src/App.tsx",
          line: 3,
          message: "Cannot find name 'missing'.",
          severity: "error",
          phase: "typecheck",
        },
      ],
      warnings: [],
      durationMs: 1,
      phases: { typecheck: "failed", build: "skipped" },
    };

    const result = await authorAndValidateAppViaLLM(
      "Build a tiny app.",
      {
        workspaceId: "ws",
        router: makeRouterWithProvider(provider),
        resolvePrompts: fixedPrompts,
        validateFn: async () => repeated,
      },
      () => {},
    );

    assert.ok(result);
    assert.equal(result!.repairAttempts, 1);
    assert.equal(result!.stoppedReason, "repeated-errors");
    assert.equal(provider.calls.length, 4);
  });
});
