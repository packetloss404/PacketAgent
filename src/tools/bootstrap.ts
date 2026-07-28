import { getDefaultToolRegistry } from "./registry.js";
import { READ_TOOLS } from "./builtins-read.js";
import { WRITE_TOOLS } from "./builtins-write.js";
import { createSandboxedShellTool } from "./sandbox.js";
import { BROWSER_TOOLS } from "./builtins-browser.js";
import { httpFetchTool } from "./http-fetch.js";
import { slackPostWebhookTool, githubApiTool } from "./slack-github.js";
import { emailSendTool, sqlQueryTool } from "./email-sql.js";
import { shellForAgentTool } from "./shell-agent.js";
import type { ToolDefinition } from "./types.js";

let registered = false;

const AGENT_CATALOG_TOOLS = [
  httpFetchTool,
  slackPostWebhookTool,
  githubApiTool,
  emailSendTool,
  sqlQueryTool,
  shellForAgentTool,
];

export function listDefaultTools(): ToolDefinition[] {
  return [
    ...READ_TOOLS,
    ...WRITE_TOOLS,
    createSandboxedShellTool(),
    ...BROWSER_TOOLS,
    ...AGENT_CATALOG_TOOLS,
  ];
}

export function listDefaultToolSummaries(): Array<{
  name: string;
  description: string;
  side: "read" | "write" | "exec";
}> {
  return listDefaultTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    side: tool.side,
  }));
}

export function listDefaultWorkerAuthorizationGaps(): string[] {
  return listDefaultTools()
    .filter((tool) => !tool.authorization)
    .map((tool) => tool.name)
    .sort();
}

export function registerDefaultTools(): void {
  if (registered) return;
  const tools = listDefaultTools();
  const authorizationGaps = tools.filter((tool) => !tool.authorization).map((tool) => tool.name);
  if (authorizationGaps.length > 0) {
    throw new Error(
      `default tools missing Worker authorization descriptors: ${authorizationGaps.join(", ")}`,
    );
  }
  registered = true;
  getDefaultToolRegistry().registerMany(tools);
}
