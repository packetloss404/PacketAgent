import { getDefaultToolRegistry } from "./registry.js";
import { READ_TOOLS } from "./builtins-read.js";
import { WRITE_TOOLS } from "./builtins-write.js";
import { createSandboxedShellTool } from "./sandbox.js";
import { BROWSER_TOOLS } from "./builtins-browser.js";
import { httpFetchTool } from "./http-fetch.js";
import { slackPostWebhookTool, githubApiTool } from "./slack-github.js";
import { emailSendTool, sqlQueryTool } from "./email-sql.js";
import { shellForAgentTool } from "./shell-agent.js";

let registered = false;

const AGENT_CATALOG_TOOLS = [
  httpFetchTool,
  slackPostWebhookTool,
  githubApiTool,
  emailSendTool,
  sqlQueryTool,
  shellForAgentTool,
];

function defaultTools() {
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
  return defaultTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    side: tool.side,
  }));
}

export function listDefaultWorkerAuthorizationGaps(): string[] {
  return defaultTools()
    .filter((tool) => !tool.authorization)
    .map((tool) => tool.name)
    .sort();
}

export function registerDefaultTools(): void {
  if (registered) return;
  const tools = defaultTools();
  const authorizationGaps = tools.filter((tool) => !tool.authorization).map((tool) => tool.name);
  if (authorizationGaps.length > 0) {
    throw new Error(
      `default tools missing Worker authorization descriptors: ${authorizationGaps.join(", ")}`,
    );
  }
  registered = true;
  getDefaultToolRegistry().registerMany(tools);
}
