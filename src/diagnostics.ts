import { recordedCall } from "./providers/ledger.js";
import { getDefaultRouter } from "./providers/router.js";
import type { AgentRunLogEntry, AgentRunRecord } from "./packetagent-store.js";

const DIAGNOSE_SYSTEM = `You are an SRE assistant. The user will give you the captured log timeline + summary of a failed agent run. Respond with strict JSON of shape:

{
  "summary": string,
  "likelyCause": string,
  "suggestion": string
}

Keep the suggestion to one or two concrete actions. Do not include any prose outside the JSON.`;

export interface RunDiagnostic {
  summary: string;
  likelyCause: string;
  suggestion: string;
  modelUsed: string;
  costUsd: number;
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("no JSON in diagnostic output");
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON");
}

export async function diagnoseFailedRun(input: {
  workspaceId: string;
  run: AgentRunRecord;
}): Promise<RunDiagnostic | null> {
  if (input.run.status !== "failed" && input.run.status !== "canceled") return null;
  const router = getDefaultRouter();
  const route = router.resolve("agent.summary");

  const logs = (input.run.logs ?? [])
    .map((log: AgentRunLogEntry) => `${log.level.toUpperCase()} ${log.message}`)
    .slice(-30)
    .join("\n");
  const userPrompt = `Run "${input.run.title}" finished with status=${input.run.status}.
${input.run.error ? `Error: ${input.run.error}\n` : ""}
Logs:
${logs || "(no logs captured)"}

Diagnose. Respond with the JSON shape described.`;

  try {
    const result = await recordedCall(
      {
        workspaceId: input.workspaceId,
        routeKey: "agent.summary",
        provider: route.provider,
        model: route.model,
      },
      () =>
        router.call({
          workspaceId: input.workspaceId,
          routeKey: "agent.summary",
          messages: [
            { role: "system", content: DIAGNOSE_SYSTEM },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          maxTokens: 600,
        }),
    );
    let parsed: { summary?: unknown; likelyCause?: unknown; suggestion?: unknown };
    try {
      parsed = extractJson(result.content) as typeof parsed;
    } catch {
      return null;
    }
    return {
      summary: String(parsed.summary ?? ""),
      likelyCause: String(parsed.likelyCause ?? ""),
      suggestion: String(parsed.suggestion ?? ""),
      modelUsed: result.model,
      costUsd: result.usage.costUsd,
    };
  } catch {
    return null;
  }
}
