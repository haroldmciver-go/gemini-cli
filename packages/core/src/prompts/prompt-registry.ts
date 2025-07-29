/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiscoveredMCPPrompt } from '../tools/mcp-client.js';

export class PromptRegistry {
  private prompts: DiscoveredMCPPrompt[] = [];

  /**
   * Registers a prompt definition.
   * @param prompt - The prompt object containing schema and execution logic.
   */
  registerPrompt(prompt: DiscoveredMCPPrompt): void {
    this.prompts.push(prompt);
  }

  /**
   * Returns an array of all registered and discovered prompt instances.
   * Name conflicts are handled by the slash command processor.
   */
  getAllPrompts(): DiscoveredMCPPrompt[] {
    return [...this.prompts].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get the definition of a specific prompt.
   * If multiple prompts share the same name, the first one found is returned.
   */
  getPrompt(name: string): DiscoveredMCPPrompt | undefined {
    return this.prompts.find((p) => p.name === name);
  }

  /**
   * Returns an array of prompts registered from a specific MCP server.
   */
  getPromptsByServer(serverName: string): DiscoveredMCPPrompt[] {
    return this.prompts
      .filter((p) => p.serverName === serverName)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}