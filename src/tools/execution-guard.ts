import type { ToolContext, ToolDefinition } from "./types.js";

const workerExecutionPermits = new WeakMap<ToolContext, string>();
const guardedTools = new WeakSet<object>();
const guardedToolCache = new WeakMap<object, object>();

export function authorizeRegisteredWorkerToolExecution(
  context: ToolContext,
  toolName: string,
): void {
  if (context.worker) workerExecutionPermits.set(context, toolName);
}

export function guardRegisteredTool<TInput>(tool: ToolDefinition<TInput>): ToolDefinition<TInput> {
  if (guardedTools.has(tool)) return tool;

  const cached = guardedToolCache.get(tool);
  if (cached) return cached as ToolDefinition<TInput>;

  const guarded: ToolDefinition<TInput> = {
    ...tool,
    async handle(input, context) {
      if (context.worker && !consumeWorkerExecutionPermit(context, tool.name)) {
        return {
          ok: false,
          error: `Registered Worker tool "${tool.name}" must execute through executeTool.`,
        };
      }
      return tool.handle(input, context);
    },
  };
  guardedTools.add(guarded);
  guardedToolCache.set(tool, guarded);
  return guarded;
}

function consumeWorkerExecutionPermit(context: ToolContext, toolName: string): boolean {
  if (workerExecutionPermits.get(context) !== toolName) return false;
  workerExecutionPermits.delete(context);
  return true;
}
