/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiscoveredMcpPrompt, promptRegistry } from '@google/gemini-cli-core';
import { SlashCommand } from '../ui/commands/types.js';
import { ICommandLoader } from './types.js';

export class PromptCommandLoader implements ICommandLoader {
  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    const prompts = promptRegistry.getAllPrompts();
    if (prompts.length === 0) {
      return [];
    }

    // Dynamically import promptCommand to avoid circular dependency issues.
    const { promptCommand } = await import('../ui/commands/promptCommand.js');
    return prompts.map((prompt: DiscoveredMcpPrompt) => promptCommand(prompt));
  }
}
