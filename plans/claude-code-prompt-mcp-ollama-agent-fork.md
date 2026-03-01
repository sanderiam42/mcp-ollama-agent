# Claude Code Prompt: Extend mcp-ollama-agent with HTTP Transport, XAA Auth, and MCP Resource Support

## Context

You are working on a fork of `https://github.com/ausboss/mcp-ollama-agent` — a TypeScript CLI chat agent that connects MCP (Model Context Protocol) servers to Ollama (a local LLM runtime). Clone the repo and work from there.

The agent currently:
- Reads `mcp-config.json` to discover MCP servers
- Connects to each server via `StdioClientTransport` (spawning local processes)
- Calls `listTools()` on each server, collects tool definitions
- Converts MCP tools into Ollama's tool-calling format
- Runs an interactive chat loop: user types → Ollama responds (optionally calling tools) → tool results fed back → repeat
- Only supports **stdio** transport and **tools** (not resources or prompts)

The key source files are:
- `src/MCPClientManager.ts` — manages MCP server connections, tool discovery
- `src/ChatManager.ts` — manages the Ollama chat loop, tool execution routing
- `mcp-config.json` — server configuration
- `package.json` — dependencies

You need to add three capabilities:
1. **StreamableHTTP transport** — connect to remote MCP servers over HTTPS
2. **XAA authentication middleware** — obtain and attach Bearer tokens for authenticated remote servers
3. **MCP Resource support** — discover and use MCP resources (not just tools) via synthetic tool definitions

These changes must be **additive**. The existing stdio + tools path must continue to work unchanged.

---

## Task 1: Add StreamableHTTP Transport to MCPClientManager.ts

Currently, every entry in `mcp-config.json` has `command` and `args` fields, and `MCPClientManager` creates a `StdioClientTransport` for each. Add a second path: when an entry has a `url` field instead, create a `StreamableHTTPClientTransport`.

**Add the import:**
```typescript
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

**Config detection logic in the server connection loop:**
- Entry has `command` field → `StdioClientTransport` (existing path, unchanged)
- Entry has `url` field → `StreamableHTTPClientTransport` (new path)

**Example config entry for a remote server:**
```json
{
  "mcpServers": {
    "todo0": {
      "transport": "streamable-http",
      "url": "https://mcp.xaa.dev/mcp",
      "auth": {
        "type": "xaa",
        "idpUrl": "https://idp.xaa.dev",
        "authServerUrl": "https://auth.resource.xaa.dev",
        "audience": "https://mcp.xaa.dev/mcp",
        "scopes": ["todos.read"]
      }
    }
  }
}
```

The `StreamableHTTPClientTransport` constructor takes a `URL` and an options object that can include a custom `fetch` function (used for auth, see Task 2):
```typescript
const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
  fetch: customFetchWithAuth,  // or just `fetch` if no auth needed
});
```

After creating the transport, the rest of the flow is identical — `client.connect(transport)`, then discover tools/resources. The MCP SDK `Client` class is transport-agnostic.

---

## Task 2: Add XAA Authentication

When a remote server config entry has `auth.type: "xaa"`, the agent must obtain a Bearer access token through a multi-step OAuth flow before connecting.

**Credentials come from environment variables** (not from the config file):
- `XAA_CLIENT_ID` — IDP client ID
- `XAA_CLIENT_SECRET` — IDP client secret
- `XAA_RESOURCE_CLIENT_ID` — resource client ID (typically `{client_id}-at-todo0`)
- `XAA_RESOURCE_CLIENT_SECRET` — resource client secret
- `XAA_ID_TOKEN` — the user's ID token (obtained separately via a helper script before the agent starts)

**Preferred approach — use the SDK's `withCrossAppAccess` middleware:**

Search the installed `@modelcontextprotocol/sdk` package for `withCrossAppAccess` and `applyMiddlewares`. If they exist:

```typescript
const xaaMiddleware = withCrossAppAccess({
  idpUrl: serverConfig.auth.idpUrl,
  idToken: process.env.XAA_ID_TOKEN,
  idpClientId: process.env.XAA_CLIENT_ID,
  idpClientSecret: process.env.XAA_CLIENT_SECRET,
  mcpClientId: process.env.XAA_RESOURCE_CLIENT_ID,
  mcpClientSecret: process.env.XAA_RESOURCE_CLIENT_SECRET,
});
const enhancedFetch = applyMiddlewares(xaaMiddleware)(fetch);
const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
  fetch: enhancedFetch,
});
```

**Fallback approach — if `withCrossAppAccess` is not available in the installed SDK version, implement the token exchange manually:**

Create a new file `src/XAAAuth.ts` that exports a function like `getXAAAccessToken(config)` which:

1. **Token Exchange (RFC 8693):** POST to `{idpUrl}/token` with:
   - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
   - `subject_token={XAA_ID_TOKEN}`
   - `subject_token_type=urn:ietf:params:oauth:token-type:id-token`
   - `requested_token_type=urn:ietf:params:oauth:token-type:oauth-id-jag+jwt`
   - `audience={authServerUrl}`
   - HTTP Basic auth with `XAA_CLIENT_ID:XAA_CLIENT_SECRET`
   - Response contains `access_token` which is the ID-JAG (5 min TTL)

2. **JWT Bearer Grant (RFC 7523):** POST to `{authServerUrl}/token` with:
   - `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
   - `assertion={id_jag_from_step_1}`
   - `scope=todos.read`
   - HTTP Basic auth with `XAA_RESOURCE_CLIENT_ID:XAA_RESOURCE_CLIENT_SECRET`
   - Response contains `access_token` which is the final Bearer token (2 hr TTL)

3. Return a custom `fetch` wrapper that adds `Authorization: Bearer {access_token}` to every request:

```typescript
export function createAuthenticatedFetch(accessToken: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };
}
```

Then in `MCPClientManager.ts`:
```typescript
import { getXAAAccessToken, createAuthenticatedFetch } from "./XAAAuth.js";

// When auth.type === "xaa":
const accessToken = await getXAAAccessToken({
  idpUrl: serverConfig.auth.idpUrl,
  authServerUrl: serverConfig.auth.authServerUrl,
  idToken: process.env.XAA_ID_TOKEN!,
  clientId: process.env.XAA_CLIENT_ID!,
  clientSecret: process.env.XAA_CLIENT_SECRET!,
  resourceClientId: process.env.XAA_RESOURCE_CLIENT_ID!,
  resourceClientSecret: process.env.XAA_RESOURCE_CLIENT_SECRET!,
  scopes: serverConfig.auth.scopes,
});
const authenticatedFetch = createAuthenticatedFetch(accessToken);
const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
  fetch: authenticatedFetch,
});
```

**Error handling:** If `XAA_ID_TOKEN` is not set or is empty, print a clear error message — "No XAA ID token found. Run ./get-xaa-token.sh to authenticate before starting the agent." — and skip connecting to that server (do not crash the entire agent, so the Postgres server still works).

---

## Task 3: Add MCP Resource Support

This is the most important architectural change. The remote Todo0 MCP server exposes **resources**, not tools:

- `todo0://todos` — all todos for authenticated user
- `todo0://todos/completed` — completed todos only
- `todo0://todos/incomplete` — incomplete todos only
- `todo0://todos/stats` — statistics (total, completed, incomplete counts)

It supports `resources/list` and `resources/read` but NOT `tools/list` or `tools/call`.

The MCP SDK `Client` already has `listResources()` and `readResource()` methods. They're just not used by this agent.

**3a. Update Client capabilities declaration**

When constructing MCP `Client` instances, ensure the capabilities include resources:

```typescript
const client = new Client(
  { name: "mcp-ollama-agent", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);
```

**3b. Discover resources in MCPClientManager.ts**

After connecting to each server, call `listResources()` in addition to `listTools()`. Wrap in try/catch — a server that only has tools will return an empty list or may error on `listResources()` if it doesn't support the capability.

```typescript
let resources: Resource[] = [];
try {
  const resourcesResult = await client.listResources();
  resources = resourcesResult.resources || [];
} catch {
  // Server doesn't support resources — that's fine
}
```

**3c. Generate synthetic tool definitions from resources**

For each discovered resource, create a tool definition that the LLM can call. These tools have **no parameters** — they're simple read operations:

```typescript
interface ResourceToolMapping {
  toolName: string;
  resourceUri: string;
  serverName: string;
}

const resourceToolMappings: ResourceToolMapping[] = [];

for (const resource of resources) {
  const toolName = sanitizeResourceName(resource.uri);
  resourceToolMappings.push({
    toolName,
    resourceUri: resource.uri,
    serverName,
  });
  
  syntheticTools.push({
    name: toolName,
    description: resource.description || `Read data from ${resource.uri}`,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  });
}
```

The `sanitizeResourceName` function converts URIs to valid tool names:
- `todo0://todos` → `resource_todo0_todos`
- `todo0://todos/completed` → `resource_todo0_todos_completed`
- `todo0://todos/stats` → `resource_todo0_todos_stats`

Strip the scheme, replace `/` and special characters with `_`, prefix with `resource_`.

**3d. Expose resource tools alongside regular tools**

`MCPClientManager` needs to return synthetic resource-tools when asked for the full tool list. The simplest approach: append them to the array that `listTools()` results already populate. Store the `resourceToolMappings` array and expose a method to look up whether a tool name is a resource-tool and which client + URI it maps to.

```typescript
// Public method for ChatManager to check
isResourceTool(toolName: string): boolean
// Public method for ChatManager to call
async readResource(toolName: string): Promise<string>
```

**3e. Route resource-tool calls in ChatManager.ts**

In the tool execution handler in `ChatManager.ts`, before calling `callTool()`, check if the tool name is a resource-tool:

```typescript
if (mcpManager.isResourceTool(toolCallName)) {
  const result = await mcpManager.readResource(toolCallName);
  // result is a string (the resource content)
  // Feed it back to Ollama as the tool result
} else {
  // Existing callTool() path
}
```

The `readResource` implementation in `MCPClientManager`:
```typescript
async readResource(toolName: string): Promise<string> {
  const mapping = this.resourceToolMappings.find(m => m.toolName === toolName);
  if (!mapping) throw new Error(`Unknown resource tool: ${toolName}`);
  
  const client = this.clients.get(mapping.serverName);
  const result = await client.readResource({ uri: mapping.resourceUri });
  
  // Combine all content items into a single string
  return result.contents
    .map(c => c.text || (c.blob ? `[binary data: ${c.blob.length} bytes]` : ""))
    .join("\n");
}
```

**3f. Update the system prompt in ChatManager.ts**

Add awareness of the Todo0 resources to the system prompt. Append to whatever system prompt is already there:

```
You also have access to a remote Todo application (Todo0).
You can read the user's todos, check completed or incomplete items, and view statistics.
Use the resource_todo0_* tools when the user asks about their todos, task lists, or productivity stats.
These tools take no arguments — just call them by name.
```

---

## Task 4: Update package.json

Bump `@modelcontextprotocol/sdk` to the latest version that includes `StreamableHTTPClientTransport`. Run `npm install` and verify the existing stdio tool-calling path still works.

If `withCrossAppAccess` is not found in the SDK, you don't need any additional packages for the manual token exchange — just Node.js `fetch` (available in Node 18+).

---

## Testing

After making the changes, verify:

1. **Existing functionality is intact:** With the original `mcp-config.json` (stdio servers only), `npm start` should work exactly as before. No regressions.

2. **HTTP transport works:** Create a test config entry with a `url` field pointing to any publicly available MCP server over HTTP (if you can find one), or mock it. The transport should connect without errors.

3. **Resource discovery works:** If you can connect to `https://mcp.xaa.dev/mcp` with a valid Bearer token, `listResources()` should return the four `todo0://` resources, and `readResource()` should return JSON data.

4. **Synthetic tool generation works:** After connecting to a resource-only server, the tool list presented to Ollama should include the `resource_todo0_*` entries with no parameters.

5. **Auth error handling works:** With `XAA_ID_TOKEN` unset, the agent should print a warning and skip the `todo0` server, but still connect to any stdio servers in the config.

---

## What NOT to Change

- Do not change the Ollama integration or replace it with another LLM provider
- Do not change how stdio transport or tool-calling works
- Do not change `mcp-config.json` — the existing format must still work; the new `url`-based format is additive
- Do not add a web UI or any interactive browser-based components to the agent itself (the browser auth flow is handled by a separate script, not the agent)
