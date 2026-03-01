// lib/ToolManager.ts

import {
  CallToolResult,
  ListToolsResultSchema,
  Resource,
} from "@modelcontextprotocol/sdk/types";
import {
  McpClientEntry,
  ToolCall,
  ToolDefinition,
} from "../utils/types/toolTypes";

import { Client } from "@modelcontextprotocol/sdk/client/index";
import { convertToOpenaiTools } from "../utils/toolFormatters";
import { createMcpClients } from "../utils/mcpClient";
import { formatToolResponse } from "../utils/toolFormatters";

interface ResourceToolMapping {
  toolName: string;
  resourceUri: string;
  serverName: string;
}

export class ToolManager {
  private toolMap: Map<string, Client> = new Map();
  protected clients: Map<string, McpClientEntry> = new Map();
  public tools: any[] = [];
  private resourceToolMappings: ResourceToolMapping[] = [];

  getClients(): Map<string, McpClientEntry> {
    return this.clients;
  }

  async initialize() {
    const newClients = await createMcpClients();
    if (!newClients || newClients.size === 0) {
      throw new Error("No MCP clients loaded.");
    }

    this.clients = newClients;
    let allMcpTools: any[] = [];

    // Fetch tools and resources from all clients
    for (const [serverName, { client }] of this.clients.entries()) {
      // --- Tools ---
      const mcpTools = await this.fetchTools(client);
      if (mcpTools) {
        allMcpTools = allMcpTools.concat(mcpTools);
        mcpTools.forEach((tool) => {
          this.toolMap.set(tool.name, client);
        });
      }

      // --- Resources ---
      let resources: Resource[] = [];
      try {
        const result = await client.listResources();
        resources = result.resources || [];
      } catch {
        // Server doesn't support resources — skip silently
      }

      for (const resource of resources) {
        const toolName = this.sanitizeResourceName(resource.uri);
        this.resourceToolMappings.push({
          toolName,
          resourceUri: resource.uri,
          serverName,
        });
        allMcpTools.push({
          name: toolName,
          description: resource.description || `Read data from ${resource.uri}`,
          inputSchema: { type: "object", properties: {}, required: [] },
        });
        // Note: resource tools are NOT added to toolMap — routing uses isResourceTool()
      }
    }

    // Convert to OpenAI format for Ollama
    this.tools = convertToOpenaiTools(allMcpTools);
    return this.tools;
  }

  private sanitizeResourceName(uri: string): string {
    // e.g. "todo0://todos/completed" → "resource_todo0_todos_completed"
    return (
      "resource_" +
      uri
        .replace(/:\/\//g, "_")
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
    );
  }

  isResourceTool(toolName: string): boolean {
    return this.resourceToolMappings.some((m) => m.toolName === toolName);
  }

  async readResource(toolName: string): Promise<string> {
    const mapping = this.resourceToolMappings.find(
      (m) => m.toolName === toolName
    );
    if (!mapping) {
      throw new Error(`Resource tool '${toolName}' not found`);
    }

    const entry = this.clients.get(mapping.serverName);
    if (!entry) {
      throw new Error(
        `No client found for server '${mapping.serverName}'`
      );
    }

    const result = await entry.client.readResource({ uri: mapping.resourceUri });
    const contents = result.contents || [];

    return contents
      .map((item: any) => {
        if (typeof item.text === "string") {
          return item.text;
        }
        return `[binary resource: ${item.mimeType || "unknown type"}]`;
      })
      .join("\n");
  }

  private async fetchTools(client: Client): Promise<any[] | null> {
    try {
      const toolsResponse = await client.listTools();
      const tools = toolsResponse?.tools || [];

      if (
        !Array.isArray(tools) ||
        !tools.every((tool) => typeof tool === "object")
      ) {
        console.debug("Invalid tools format received.");
        return null;
      }

      return tools;
    } catch (error) {
      console.error("Error fetching tools:", error);
      return null;
    }
  }

  private async callToolWithTimeout(
    client: Client,
    name: string,
    args: any,
    timeoutMs = 30000
  ): Promise<unknown> {
    // Parse arguments if they're a string
    let parsedArgs = args;
    if (typeof args === "string") {
      try {
        parsedArgs = JSON.parse(args);
      } catch (e) {
        // If parsing fails, wrap the string in an object
        parsedArgs = { value: args };
      }
    }

    // Ensure args is an object
    if (typeof parsedArgs !== "object" || parsedArgs === null) {
      parsedArgs = {};
    }

    const toolCallPromise = client.callTool({
      name,
      arguments: parsedArgs,
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`Tool call timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    try {
      const result = await Promise.race([toolCallPromise, timeoutPromise]);
      return result;
    } catch (error) {
      throw new Error(
        `Tool call failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async executeToolCall(toolCall: ToolCall): Promise<string> {
    const { name, args } = this.parseToolCall(toolCall);
    const client = this.toolMap.get(name);

    if (!client) {
      throw new Error(`Tool '${name}' not found`);
    }

    const result = await this.callToolWithTimeout(client, name, args);
    return formatToolResponse((result as any)?.content || []);
  }

  private parseToolCall(toolCall: any): { name: string; args: any } {
    let toolName = "unknown_tool";
    let rawArguments: any = {};

    if (
      (typeof toolCall === "object" &&
        toolCall !== null &&
        "function" in toolCall) ||
      (toolCall?.function?.name && toolCall?.function?.arguments)
    ) {
      if (toolCall.function?.name) {
        toolName = toolCall.function.name;
        rawArguments = toolCall.function.arguments;
      } else {
        toolName = toolCall["function"]["name"];
        rawArguments = toolCall["function"]["arguments"];
      }
    } else {
      throw new Error("Invalid tool call format provided.");
    }

    let toolArgs: any = rawArguments;
    if (typeof rawArguments === "string") {
      try {
        toolArgs = JSON.parse(rawArguments);
      } catch (error: any) {
        console.debug(
          `Error parsing arguments string: ${error.message}`,
          rawArguments
        );
        throw error;
      }
    }

    return { name: toolName, args: toolArgs };
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult | undefined> {
    const clientForTool = this.toolMap.get(toolName);
    if (!clientForTool) {
      console.warn(`Tool '${toolName}' not found among available tools.`);
      return undefined;
    }

    try {
      const toolCall = {
        name: toolName,
        arguments: args,
      };

      return (await clientForTool.callTool(toolCall)) as CallToolResult;
    } catch (error) {
      console.error(`Error calling tool '${toolName}':`, error);
      return undefined;
    }
  }

  getToolParameterInfo(toolName: string): ToolDefinition | undefined {
    return this.tools.find((t) => t.name === toolName);
  }

  suggestParameterMapping(
    toolName: string,
    providedArgs: Record<string, unknown>
  ): Record<string, string> {
    const tool = this.getToolParameterInfo(toolName);
    if (!tool) return {};

    const mapping: Record<string, string> = {};
    const expectedParams = Object.keys(tool.parameters.properties);

    for (const providedParam of Object.keys(providedArgs)) {
      if (expectedParams.includes(providedParam)) {
        continue; // Parameter is already correct
      }

      const mostSimilar = this.findMostSimilarParameter(
        providedParam,
        expectedParams
      );
      if (mostSimilar) {
        mapping[providedParam] = mostSimilar;
      }
    }

    return mapping;
  }

  private findMostSimilarParameter(
    provided: string,
    expected: string[]
  ): string | null {
    const normalized = provided.toLowerCase().replace(/[_-]/g, "");
    for (const param of expected) {
      const normalizedExpected = param.toLowerCase().replace(/[_-]/g, "");
      if (
        normalizedExpected.includes(normalized) ||
        normalized.includes(normalizedExpected)
      ) {
        return param;
      }
    }
    return null;
  }

  async cleanup() {
    if (this.clients) {
      for (const { client, transport } of this.clients.values()) {
        await client.close();
        await transport.close();
      }
    }
  }
}
