#!/usr/bin/env node

/**
 * Standalone MCP server mode.
 *
 * Runs pi-browser-use as a standalone process that speaks MCP over stdio.
 * Used when pi-browser-use is configured as an external MCP server (e.g. in mcp.json)
 * rather than loaded as a pi-coding-agent extension.
 */

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createFetchVisionCaller, handleAnalyzeScreenshot } from './analyze-screenshot.js';
import { type BrowserUseConfig, resolveConfig } from './config.js';
import { DevToolsClient } from './index.js';
import { prepareBrowserProfile } from './profile.js';
import { readBrowserSessionBinding } from './session-backend.js';
import { SESSION_DESCRIPTION, sessionParameters, sessionToolResult } from './session-control.js';
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from './tool-augment.js';

const TOOL_PREFIX = 'browser_';
const EXCLUDED_TOOLS = new Set([
  'lighthouse_audit',
  'performance_analyze_insight',
  'performance_start_trace',
  'performance_stop_trace',
  'screencast_start',
  'screencast_stop',
  'install_extension',
  'list_extensions',
  'reload_extension',
  'trigger_extension_action',
  'uninstall_extension',
]);
const ARRAY_CONFIG_KEYS = new Set([
  'allowedUrlPattern',
  'blockedUrlPattern',
  'envAllowlist',
  'envBlocklist',
]);

export function parseArgs(argv: string[]): BrowserUseConfig {
  const config: BrowserUseConfig = {};
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '--config' && argv[i + 1] != null) {
      const configPath = argv[i + 1]!;
      let raw: string;
      try {
        raw = readFileSync(configPath, 'utf-8');
      } catch {
        throw new Error(`Cannot read config file: ${configPath}`);
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid JSON in config file: ${configPath}`);
      }
      const section = (parsed['pi-browser-use'] ?? parsed) as BrowserUseConfig;
      Object.assign(config, section);
      i += 2;
      continue;
    }

    const match = arg.match(/^--([a-z-]+)(?:=(.+))?$/);
    if (match) {
      const key = match[1]!;
      const value = match[2];
      const camelKey = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

      if (value === undefined || value === 'true') {
        (config as Record<string, unknown>)[camelKey] = true;
      } else if (value === 'false') {
        (config as Record<string, unknown>)[camelKey] = false;
      } else if (ARRAY_CONFIG_KEYS.has(camelKey)) {
        const existing = (config as Record<string, unknown>)[camelKey];
        (config as Record<string, unknown>)[camelKey] = [
          ...(Array.isArray(existing) ? existing : []),
          value,
        ];
      } else {
        (config as Record<string, unknown>)[camelKey] = value;
      }
    }

    i++;
  }

  return config;
}

async function main(): Promise<void> {
  const config = resolveConfig(parseArgs(process.argv.slice(2)));
  prepareBrowserProfile(config);
  const client = new DevToolsClient(config, readBrowserSessionBinding(config));
  await client.connect();

  const toolNameMap = new Map<string, string>();

  const server = new Server(
    { name: 'pi-browser-use', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const upstreamTools = await client.listAllTools(extra.signal);
    const tools = [];
    toolNameMap.clear();
    if (config.session?.enabled) {
      toolNameMap.set('browser_session', 'session');
      tools.push({
        name: 'browser_session',
        description: SESSION_DESCRIPTION,
        inputSchema: sessionParameters,
      });
    }

    for (const tool of upstreamTools) {
      if (EXCLUDED_TOOLS.has(tool.name)) continue;
      const prefixedName = `${TOOL_PREFIX}${tool.name}`;
      toolNameMap.set(prefixedName, tool.name);
      tools.push({
        ...tool,
        name: prefixedName,
        description: augmentToolDescription(tool.name, tool.description ?? ''),
      });
    }

    if (config.visionModel) {
      const name = `${TOOL_PREFIX}analyze_screenshot`;
      toolNameMap.set(name, 'analyze_screenshot');
      tools.push({
        name,
        description: 'Analyze the current page visually using a screenshot.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            ...(config.experimentalPageIdRouting
              ? {
                  pageId: {
                    type: 'number',
                    description: 'Numeric page ID returned by browser_list_pages.',
                  },
                }
              : {}),
            instruction: {
              type: 'string',
              description: 'What to identify or analyze visually.',
            },
          },
          required: config.experimentalPageIdRouting ? ['pageId'] : [],
        },
      });
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const originalName = toolNameMap.get(name);
    if (!originalName) throw new Error(`Unknown tool: ${name}`);

    if (originalName === 'session')
      return sessionToolResult(
        args?.action,
        config.session?.enabled
          ? (action, signal) => client.sessionControl(action, signal)
          : undefined,
        extra.signal,
      );

    if (originalName === 'analyze_screenshot' && config.visionModel) {
      const callVision = createFetchVisionCaller(config.visionModel);
      return await handleAnalyzeScreenshot(client, callVision, args ?? {}, extra.signal);
    }

    const result = await client.callTool(originalName, args ?? {}, extra.signal);
    const textContent = extractTextContent(result.content);
    const processed = postProcessToolResult(originalName, textContent);

    if (processed !== textContent) {
      const newContent = (result.content ?? []).map((item) => {
        if (item.type === 'text') {
          return { ...item, text: processed };
        }
        return item;
      });
      return { ...result, content: newContent } as Record<string, unknown>;
    }

    return result as Record<string, unknown>;
  });

  const transport = new StdioServerTransport();
  server.onclose = () => {
    void client
      .close()
      .catch(() => console.error('[pi-browser-use] browser session disconnect failed'));
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void client.close().finally(() => process.exit());
    });
  }
  await server.connect(transport);
}

main().catch(() => {
  console.error(
    '[pi-browser-use] startup failed; check browser configuration and runtime availability',
  );
  process.exit(1);
});
