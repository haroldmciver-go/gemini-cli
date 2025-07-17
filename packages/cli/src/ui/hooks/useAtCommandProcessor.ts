/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { promptRegistry } from '@google/gemini-cli-core';

// A simple regex to parse the @command structure.
// It captures:
// 1. The server name (e.g., "mcpserver")
// 2. The prompt name (e.g., "code-review")
// 3. The arguments string (e.g., "--changelist="123456" --priority high")
const AT_COMMAND_REGEX = /^@(\S+)\s+(\S+)(?:\s+(.*))?$/;

// A simple regex to parse arguments, handling quotes.
const ARGS_REGEX = /--(\w+)(?:[=\s]((?:"[^"]*")|(?:\S+)))?/g;

interface ParsedArgs {
  [key: string]: string;
}

function parseArgs(argString: string): ParsedArgs {
  const args: ParsedArgs = {};
  if (!argString) {
    return args;
  }

  let match;
  while ((match = ARGS_REGEX.exec(argString)) !== null) {
    const key = match[1];
    // Remove quotes from the value if they exist.
    const value = match[2] ? match[2].replace(/^"|"$/g, '') : 'true';
    args[key] = value;
  }

  return args;
}

function substituteArgs(template: string, args: ParsedArgs): string {
  let result = template;
  for (const key in args) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, args[key]);
  }
  return result;
}

export function useAtCommandProcessor() {
  const processCommand = useCallback(
    (
      inputValue: string,
    ): {
      finalPrompt?: string;
      error?: string;
    } => {
      if (!inputValue.startsWith('@')) {
        return {};
      }

      const match = inputValue.match(AT_COMMAND_REGEX);
      if (!match) {
        return {
          error: `Invalid @command format. Use @server prompt --arg="value"`,
        };
      }

      const [, serverName, promptName, argsString] = match;
      const prompt = promptRegistry.getPrompt(serverName, promptName);

      if (!prompt) {
        return {
          error: `Prompt '${promptName}' not found on server '${serverName}'.`,
        };
      }

      const args = parseArgs(argsString);
      const missingArgs = prompt.parameters.required.filter(
        (requiredArg) => !(requiredArg in args),
      );

      if (missingArgs.length > 0) {
        return {
          error: `Missing required arguments for '${promptName}': ${missingArgs.join(', ')}`,
        };
      }

      const finalPrompt = substituteArgs(prompt.template, args);
      return { finalPrompt };
    },
    [],
  );

  return { processCommand };
}
