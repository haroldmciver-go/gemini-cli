/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  SSEClientTransport,
  SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse } from 'shell-quote';
import { MCPServerConfig } from '../config/config.js';
import { DiscoveredMCPTool } from './mcp-tool.js';

import { FunctionDeclaration, mcpToTool } from '@google/genai';
import { ToolRegistry } from './tool-registry.js';
import {
  ListPromptsResponseSchema,
  ListToolsResponseSchema,
} from './mcp-protocol.js';
import {
  ActiveFileNotificationSchema,
  IDE_SERVER_NAME,
  ideContext,
} from '../services/ideContext.js';
import { promptRegistry, McpPrompt } from '../services/prompt-registry.js';
import { z } from 'zod';

export const MCP_DEFAULT_TIMEOUT_MSEC = 10 * 60 * 1000; // default to 10 minutes

/**
 * Enum representing the connection status of an MCP server
 */
export enum MCPServerStatus {
  /** Server is disconnected or experiencing errors */
  DISCONNECTED = 'disconnected',
  /** Server is in the process of connecting */
  CONNECTING = 'connecting',
  /** Server is connected and ready to use */
  CONNECTED = 'connected',
}

/**
 * Enum representing the overall MCP discovery state
 */
export enum MCPDiscoveryState {
  /** Discovery has not started yet */
  NOT_STARTED = 'not_started',
  /** Discovery is currently in progress */
  IN_PROGRESS = 'in_progress',
  /** Discovery has completed (with or without errors) */
  COMPLETED = 'completed',
}

/**
 * Map to track the status of each MCP server within the core package
 */
const mcpServerStatusesInternal: Map<string, MCPServerStatus> = new Map();
const mcpClients: Map<string, Client> = new Map();

/**
 * Track the overall MCP discovery state
 */
let mcpDiscoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;

/**
 * Event listeners for MCP server status changes
 */
type StatusChangeListener = (
  serverName: string,
  status: MCPServerStatus,
) => void;
const statusChangeListeners: StatusChangeListener[] = [];

/**
 * Add a listener for MCP server status changes
 */
export function addMCPStatusChangeListener(
  listener: StatusChangeListener,
): void {
  statusChangeListeners.push(listener);
}

/**
 * Remove a listener for MCP server status changes
 */
export function removeMCPStatusChangeListener(
  listener: StatusChangeListener,
): void {
  const index = statusChangeListeners.indexOf(listener);
  if (index !== -1) {
    statusChangeListeners.splice(index, 1);
  }
}

/**
 * Update the status of an MCP server
 */
function updateMCPServerStatus(
  serverName: string,
  status: MCPServerStatus,
): void {
  mcpServerStatusesInternal.set(serverName, status);
  // Notify all listeners
  for (const listener of statusChangeListeners) {
    listener(serverName, status);
  }
}

/**
 * Get the current status of an MCP server
 */
export function getMCPServerStatus(serverName: string): MCPServerStatus {
  return (
    mcpServerStatusesInternal.get(serverName) || MCPServerStatus.DISCONNECTED
  );
}

/**
 * Get all MCP server statuses
 */
export function getAllMCPServerStatuses(): Map<string, MCPServerStatus> {
  return new Map(mcpServerStatusesInternal);
}

/**
 * Get the current MCP discovery state
 */
export function getMCPDiscoveryState(): MCPDiscoveryState {
  return mcpDiscoveryState;
}

/**
 * Discovers tools from all configured MCP servers and registers them with the tool registry.
 * It orchestrates the connection and discovery process for each server defined in the
 * configuration, as well as any server specified via a command-line argument.
 *
 * @param mcpServers A record of named MCP server configurations.
 * @param mcpServerCommand An optional command string for a dynamically specified MCP server.
 * @param toolRegistry The central registry where discovered tools will be registered.
 * @returns A promise that resolves when the discovery process has been attempted for all servers.
 */
export async function discoverMcpTools(
  mcpServers: Record<string, MCPServerConfig>,
  mcpServerCommand: string | undefined,
  toolRegistry: ToolRegistry,
  debugMode: boolean,
): Promise<void> {
  mcpDiscoveryState = MCPDiscoveryState.IN_PROGRESS;
  try {
    mcpServers = populateMcpServerCommand(mcpServers, mcpServerCommand);

    const discoveryPromises = Object.entries(mcpServers).map(
      ([mcpServerName, mcpServerConfig]) =>
        connectAndDiscover(
          mcpServerName,
          mcpServerConfig,
          toolRegistry,
          debugMode,
        ),
    );
    await Promise.all(discoveryPromises);
  } finally {
    mcpDiscoveryState = MCPDiscoveryState.COMPLETED;
  }
}

/** Visible for Testing */
export function populateMcpServerCommand(
  mcpServers: Record<string, MCPServerConfig>,
  mcpServerCommand: string | undefined,
): Record<string, MCPServerConfig> {
  if (mcpServerCommand) {
    const cmd = mcpServerCommand;
    const args = parse(cmd, process.env) as string[];
    if (args.some((arg) => typeof arg !== 'string')) {
      throw new Error('failed to parse mcpServerCommand: ' + cmd);
    }
    // use generic server name 'mcp'
    mcpServers['mcp'] = {
      command: args[0],
      args: args.slice(1),
    };
  }
  return mcpServers;
}

/**
 * Connects to an MCP server and discovers available tools, registering them with the tool registry.
 * This function handles the complete lifecycle of connecting to a server, discovering tools,
 * and cleaning up resources if no tools are found.
 *
 * @param mcpServerName The name identifier for this MCP server
 * @param mcpServerConfig Configuration object containing connection details
 * @param toolRegistry The registry to register discovered tools with
 * @returns Promise that resolves when discovery is complete
 */
export async function connectAndDiscover(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  toolRegistry: ToolRegistry,
  debugMode: boolean,
): Promise<void> {
  updateMCPServerStatus(mcpServerName, MCPServerStatus.CONNECTING);

  let mcpClient: Client | undefined;
  try {
    mcpClient = await connectToMcpServer(
      mcpServerName,
      mcpServerConfig,
      debugMode,
    );
    mcpClients.set(mcpServerName, mcpClient);

    updateMCPServerStatus(mcpServerName, MCPServerStatus.CONNECTED);

    mcpClient.onerror = (error) => {
      console.error(`MCP ERROR (${mcpServerName}):`, error.toString());
      updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
      if (mcpServerName === IDE_SERVER_NAME) {
        ideContext.clearActiveFileContext();
      }
    };

    if (mcpServerName === IDE_SERVER_NAME) {
      mcpClient.setNotificationHandler(
        ActiveFileNotificationSchema,
        (notification) => {
          ideContext.setActiveFileContext(notification.params);
        },
      );
    }

    try {
      const { tools, prompts } = await discoverToolsAndPrompts(
        mcpServerName,
        mcpServerConfig,
        mcpClient,
      );

      for (const tool of tools) {
        toolRegistry.registerTool(tool);
      }

      for (const prompt of prompts) {
        promptRegistry.registerPrompt({
          ...prompt,
          serverName: mcpServerName,
        });
      }

      if (tools.length === 0 && prompts.length === 0) {
        // No tools or prompts were found, so we don't need to keep the connection open.
        mcpClient.close();
        updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
      }
    } catch (error) {
      console.debug(
        `Could not discover tools or prompts from '${mcpServerName}': ${error}`,
      );
      mcpClient.close();
      updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
    }
  } catch (error) {
    if (mcpClient) {
      mcpClient.close();
    }
    console.error(`Error connecting to MCP server '${mcpServerName}':`, error);
    updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
  }
}

/**
 * Discovers and sanitizes tools from a connected MCP client.
 * It retrieves function declarations from the client, filters out disabled tools,
 * generates valid names for them, and wraps them in `DiscoveredMCPTool` instances.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpServerConfig The configuration for the MCP server.
 * @param mcpClient The active MCP client instance.
 * @returns A promise that resolves to an array of discovered and enabled tools.
 * @throws An error if no enabled tools are found or if the server provides invalid function declarations.
 */
export async function discoverToolsAndPrompts(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  mcpClient: Client,
): Promise<{ tools: DiscoveredMCPTool[]; prompts: McpPrompt[] }> {
  const discoveredTools: DiscoveredMCPTool[] = [];
  const discoveredPrompts: McpPrompt[] = [];

  // Using a try-catch block for each discovery type to allow one to succeed
  // even if the other fails.
  try {
    const toolsResponse = await mcpClient.request(
      { method: 'tools/list' },
      ListToolsResponseSchema,
    );

    const mcpCallableTool = mcpToTool(mcpClient);

    for (const funcDecl of toolsResponse.tools as FunctionDeclaration[]) {
      if (!isEnabled(funcDecl, mcpServerName, mcpServerConfig)) {
        continue;
      }

      const toolNameForModel = generateValidName(funcDecl, mcpServerName);

      discoveredTools.push(
        new DiscoveredMCPTool(
          mcpCallableTool,
          mcpServerName,
          toolNameForModel,
          funcDecl.description ?? '',
          funcDecl.parametersJsonSchema ??
            funcDecl.parameters ?? { type: 'object', properties: {} },
          mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
          mcpServerConfig.trust,
        ),
      );
    }
  } catch (e) {
    // It's okay if this fails, maybe the server only has prompts.
    console.debug(`Could not discover tools from '${mcpServerName}': ${e}`);
  }

  try {
    const promptsResponse = await mcpClient.request(
      { method: 'prompts/list' },
      ListPromptsResponseSchema,
    );

    for (const prompt of promptsResponse.prompts) {
      if (prompt.template) {
        // We can safely cast here because we've confirmed `template` exists.
        discoveredPrompts.push(prompt as McpPrompt);
      }
    }
    console.log('Discovered Prompts:', discoveredPrompts);
  } catch (e) {
    // It's okay if this fails, maybe the server only has tools.
    console.log(`Could not discover prompts from '${mcpServerName}': ${e}`);
    console.debug(`Could not discover prompts from '${mcpServerName}': ${e}`);
  }

  if (discoveredTools.length === 0 && discoveredPrompts.length === 0) {
    throw Error('No enabled tools or prompts found');
  }
  return { tools: discoveredTools, prompts: discoveredPrompts };
}

/**
 * Creates and connects an MCP client to a server based on the provided configuration.
 * It determines the appropriate transport (Stdio, SSE, or Streamable HTTP) and
 * establishes a connection. It also applies a patch to handle request timeouts.
 *
 * @param mcpServerName The name of the MCP server, used for logging and identification.
 * @param mcpServerConfig The configuration specifying how to connect to the server.
 * @returns A promise that resolves to a connected MCP `Client` instance.
 * @throws An error if the connection fails or the configuration is invalid.
 */
export async function connectToMcpServer(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  debugMode: boolean,
): Promise<Client> {
  const mcpClient = new Client({
    name: 'gemini-cli-mcp-client',
    version: '0.0.1',
  });

  // patch Client.callTool to use request timeout as genai McpCallTool.callTool does not do it
  // TODO: remove this hack once GenAI SDK does callTool with request options
  if ('callTool' in mcpClient) {
    const origCallTool = mcpClient.callTool.bind(mcpClient);
    mcpClient.callTool = function (params, resultSchema, options) {
      return origCallTool(params, resultSchema, {
        ...options,
        timeout: mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
      });
    };
  }

  try {
    const transport = createTransport(
      mcpServerName,
      mcpServerConfig,
      debugMode,
    );
    try {
      await mcpClient.connect(transport, {
        timeout: mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
      });
      return mcpClient;
    } catch (error) {
      await transport.close();
      throw error;
    }
  } catch (error) {
    // Create a safe config object that excludes sensitive information
    const safeConfig = {
      command: mcpServerConfig.command,
      url: mcpServerConfig.url,
      httpUrl: mcpServerConfig.httpUrl,
      cwd: mcpServerConfig.cwd,
      timeout: mcpServerConfig.timeout,
      trust: mcpServerConfig.trust,
      // Exclude args, env, and headers which may contain sensitive data
    };

    let errorString =
      `failed to start or connect to MCP server '${mcpServerName}' ` +
      `${JSON.stringify(safeConfig)}; \n${error}`;
    if (process.env.SANDBOX) {
      errorString += `\nMake sure it is available in the sandbox`;
    }
    throw new Error(errorString);
  }
}

/** Visible for Testing */
export function createTransport(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  debugMode: boolean,
): Transport {
  if (mcpServerConfig.httpUrl) {
    const transportOptions: StreamableHTTPClientTransportOptions = {};
    if (mcpServerConfig.headers) {
      transportOptions.requestInit = {
        headers: mcpServerConfig.headers,
      };
    }
    return new StreamableHTTPClientTransport(
      new URL(mcpServerConfig.httpUrl),
      transportOptions,
    );
  }

  if (mcpServerConfig.url) {
    const transportOptions: SSEClientTransportOptions = {};
    if (mcpServerConfig.headers) {
      transportOptions.requestInit = {
        headers: mcpServerConfig.headers,
      };
    }
    return new SSEClientTransport(
      new URL(mcpServerConfig.url),
      transportOptions,
    );
  }

  if (mcpServerConfig.command) {
    const transport = new StdioClientTransport({
      command: mcpServerConfig.command,
      args: mcpServerConfig.args || [],
      env: {
        ...process.env,
        ...(mcpServerConfig.env || {}),
      } as Record<string, string>,
      cwd: mcpServerConfig.cwd,
      stderr: 'pipe',
    });
    if (debugMode) {
      transport.stderr!.on('data', (data) => {
        const stderrStr = data.toString().trim();
        console.debug(`[DEBUG] [MCP STDERR (${mcpServerName})]: `, stderrStr);
      });
    }
    return transport;
  }

  throw new Error(
    `Invalid configuration: missing httpUrl (for Streamable HTTP), url (for SSE), and command (for stdio).`,
  );
}

/** Visible for testing */
export function isEnabled(
  funcDecl: FunctionDeclaration,
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
): boolean {
  if (!funcDecl.name) {
    console.warn(
      `Discovered a function declaration without a name from MCP server '${mcpServerName}'. Skipping.`,
    );
    return false;
  }
  const { includeTools, excludeTools } = mcpServerConfig;

  // excludeTools takes precedence over includeTools
  if (excludeTools && excludeTools.includes(funcDecl.name)) {
    return false;
  }

  return (
    !includeTools ||
    includeTools.some(
      (tool) => tool === funcDecl.name || tool.startsWith(`${funcDecl.name}(`),
    )
  );
}

/**
 * Generates a valid tool name for the model, ensuring it's unique across different MCP servers.
 * The format is `mcpServerName__toolName`.
 *
 * @param funcDecl The function declaration from the MCP server.
 * @param mcpServerName The name of the MCP server.
 * @returns A sanitized and unique tool name.
 */
function generateValidName(
  funcDecl: FunctionDeclaration,
  mcpServerName: string,
): string {
  // Replace any characters that are not letters, numbers, or underscores with underscores.
  const sanitizedToolName = funcDecl.name!.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${mcpServerName}__${sanitizedToolName}`;
}

export async function mcpRequest<T, U extends object>(
  serverName: string,
  method: string,
  params: T,
  responseSchema: z.ZodType<U>,
): Promise<{ type: 'success'; result: U } | { type: 'error'; error: string }> {
  const client = mcpClients.get(serverName);
  if (!client) {
    return { type: 'error', error: `MCP server not found: ${serverName}` };
  }

  try {
    const result = await client.request(
      { method, params: params as Record<string, unknown> },
      responseSchema,
    );
    return { type: 'success', result: result as U };
  } catch (e) {
    return { type: 'error', error: (e as Error).message };
  }
}
