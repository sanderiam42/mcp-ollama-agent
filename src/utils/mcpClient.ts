// src/utils/mcpClient.ts

import { Client } from "@modelcontextprotocol/sdk/client/index";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getConfig } from "../config/index";
import { getDefaultEnvironment } from "./environment";
import { resolveCommand } from "./commandResolver";
import { getXAAAccessToken, createAuthenticatedFetch } from "../XAAAuth";

export interface McpServerConfiguration {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  capabilities?: any;
}

export async function createMcpClients() {
  const config = getConfig();
  const clients = new Map<
    string,
    { client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport }
  >();

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    // Branch on url (HTTP) vs command (stdio)
    if (serverConfig.url) {
      // --- StreamableHTTP transport ---
      let fetchImpl: typeof fetch | undefined;

      if (serverConfig.auth?.type === "xaa") {
        const idToken = process.env.XAA_ID_TOKEN;
        if (!idToken) {
          console.error(
            `[${serverName}] Skipping: auth.type is "xaa" but XAA_ID_TOKEN env var is not set.`
          );
          continue;
        }

        try {
          const accessToken = await getXAAAccessToken({
            idpUrl: serverConfig.auth.idpUrl,
            authServerUrl: serverConfig.auth.authServerUrl,
            audience: serverConfig.auth.audience,
            scopes: serverConfig.auth.scopes,
            idToken,
          });
          fetchImpl = createAuthenticatedFetch(accessToken);
        } catch (error) {
          console.error(
            `[${serverName}] Skipping: failed to obtain XAA access token:`,
            error instanceof Error ? error.message : String(error)
          );
          continue;
        }
      }

      const transport = new StreamableHTTPClientTransport(
        new URL(serverConfig.url),
        fetchImpl ? { fetch: fetchImpl } : undefined
      );

      const client = new Client(
        { name: `ollama-client-${serverName}`, version: "1.0.0" },
        {
          capabilities: {
            tools: { call: true, list: true },
            resources: {},
          },
        }
      );

      await client.connect(transport);
      clients.set(serverName, { client, transport });
    } else if (serverConfig.command) {
      // --- Stdio transport (existing path, unchanged) ---
      const resolvedCommand = await resolveCommand(serverConfig.command);

      const transport = new StdioClientTransport({
        command: resolvedCommand,
        args: serverConfig.args || [],
        env:
          (serverConfig.env as Record<string, string> | undefined) ||
          getDefaultEnvironment(),
      });

      const client = new Client(
        { name: `ollama-client-${serverName}`, version: "1.0.0" },
        {
          capabilities: {
            tools: { call: true, list: true },
            resources: {},
          },
        }
      );

      await client.connect(transport);
      clients.set(serverName, { client, transport });
    } else {
      console.error(
        `[${serverName}] Skipping: ServerConfig must have either "command" or "url".`
      );
    }
  }

  return clients;
}
