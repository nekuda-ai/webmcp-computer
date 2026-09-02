import type { AnyWebMCPTool } from "@nekuda/webmcp-sdk";

const scopes = new Map<string, readonly AnyWebMCPTool[]>();

export function setToolCatalogScope(scope: string, tools: readonly AnyWebMCPTool[]): void {
  scopes.set(scope, tools);
}

export function removeToolCatalogScope(scope: string): void {
  scopes.delete(scope);
}

export function activeToolDefinitions(): AnyWebMCPTool[] {
  const byName = new Map<string, AnyWebMCPTool>();
  for (const tools of scopes.values()) {
    for (const tool of tools) byName.set(tool.name, tool);
  }
  return [...byName.values()];
}

export function getActiveToolDefinition(name: string): AnyWebMCPTool | undefined {
  return activeToolDefinitions().find((tool) => tool.name === name);
}

function indented(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

export function renderToolManPage(tool: AnyWebMCPTool): string {
  const schema = JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} }, null, 2);
  return [
    `${tool.name.toUpperCase()}(1) — WebMCP Computer syscalls`,
    "",
    "NAME",
    `  ${tool.name} - ${tool.title ?? tool.name}`,
    "",
    "DESCRIPTION",
    `  ${tool.description}`,
    "",
    "INPUT SCHEMA",
    indented(schema),
    "",
  ].join("\n");
}

export function resetToolCatalog(): void {
  scopes.clear();
}
