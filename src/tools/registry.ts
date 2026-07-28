import type { ToolDefinition } from "./types.js";
import { guardRegisteredTool } from "./execution-guard.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, guardRegisteredTool(tool));
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  filter(names: string[]): ToolDefinition[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((tool): tool is ToolDefinition => Boolean(tool));
  }

  hasName(name: string): boolean {
    return this.tools.has(name);
  }
}

let defaultRegistry: ToolRegistry | null = null;

export function getDefaultToolRegistry(): ToolRegistry {
  if (!defaultRegistry) defaultRegistry = new ToolRegistry();
  return defaultRegistry;
}

export function resetDefaultToolRegistryForTests(): void {
  defaultRegistry = null;
}
