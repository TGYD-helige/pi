import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteDashboardModule,
  ensureDashboardWorkspace,
  readDashboardManifest,
  updateDashboardLayout,
  upsertDashboardModule,
  writeDashboardManifest,
} from './manifest.js';
import type {
  DashboardDataSource,
  DashboardLayoutItem,
  DashboardModule,
  DashboardResolvedPayload,
  DashboardServerHandle,
} from './types.js';

export type StartDashboardServerOptions = {
  workspaceDir: string;
  host?: string;
  port?: number;
  staticDir?: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
};

type JsonRequest = {
  layout?: DashboardLayoutItem[];
  manifest?: unknown;
  module?: DashboardModule;
};

const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function startDashboardServer(
  options: StartDashboardServerOptions,
): Promise<DashboardServerHandle> {
  const workspaceDir = resolve(options.workspaceDir);
  const host = options.host ?? DEFAULT_HOST;
  await ensureDashboardWorkspace(workspaceDir);
  const staticDir = options.staticDir ?? defaultStaticDir();
  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      workspaceDir,
      staticDir,
      logger: options.logger ?? console,
    }).catch((error) =>
      writeJson(response, statusFromError(error), {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('dashboard server did not expose a TCP address');
  }
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

async function handleRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  workspaceDir: string;
  staticDir: string;
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
}): Promise<void> {
  const url = new URL(input.request.url ?? '/', 'http://localhost');
  if (input.request.method === 'OPTIONS') {
    input.response.writeHead(204, corsHeaders());
    input.response.end();
    return;
  }
  if (input.request.method === 'GET' && url.pathname === '/health') {
    writeJson(input.response, 200, { ok: true });
    return;
  }
  if (input.request.method === 'GET' && url.pathname === '/api/dashboard') {
    writeJson(input.response, 200, await resolveDashboardPayload(input.workspaceDir));
    return;
  }
  if (input.request.method === 'GET' && url.pathname === '/api/dashboard/manifest') {
    writeJson(input.response, 200, { manifest: await readDashboardManifest(input.workspaceDir) });
    return;
  }
  if (input.request.method === 'PUT' && url.pathname === '/api/dashboard/manifest') {
    const body = await readJson<JsonRequest>(input.request);
    const manifest = await writeDashboardManifest(input.workspaceDir, body.manifest as never);
    writeJson(input.response, 200, { manifest });
    return;
  }
  if (input.request.method === 'POST' && url.pathname === '/api/dashboard/layout') {
    const body = await readJson<JsonRequest>(input.request);
    if (!Array.isArray(body.layout)) throw httpError(400, 'layout array is required');
    const manifest = await updateDashboardLayout(input.workspaceDir, body.layout);
    writeJson(input.response, 200, { manifest });
    return;
  }
  if (input.request.method === 'POST' && url.pathname === '/api/dashboard/modules') {
    const body = await readJson<JsonRequest>(input.request);
    if (!body.module) throw httpError(400, 'module is required');
    const manifest = await upsertDashboardModule(input.workspaceDir, body.module);
    writeJson(input.response, 200, { manifest });
    return;
  }
  if (input.request.method === 'PATCH' && url.pathname.startsWith('/api/dashboard/modules/')) {
    const moduleId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
    const body = await readJson<JsonRequest>(input.request);
    if (!moduleId || !body.module) throw httpError(400, 'module id and module are required');
    const manifest = await upsertDashboardModule(input.workspaceDir, {
      ...body.module,
      id: moduleId,
    });
    writeJson(input.response, 200, { manifest });
    return;
  }
  if (input.request.method === 'DELETE' && url.pathname.startsWith('/api/dashboard/modules/')) {
    const moduleId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
    if (!moduleId) throw httpError(400, 'module id is required');
    const manifest = await deleteDashboardModule(input.workspaceDir, moduleId);
    writeJson(input.response, 200, { manifest });
    return;
  }
  if (input.request.method === 'GET') {
    await serveStatic(input.response, input.staticDir, url.pathname);
    return;
  }
  writeJson(input.response, 404, { error: 'not found' });
}

export async function resolveDashboardPayload(
  workspaceDir: string,
): Promise<DashboardResolvedPayload> {
  const manifest = await readDashboardManifest(workspaceDir);
  const entries = await Promise.all(
    manifest.dataSources.map(
      async (source) => [source.id, await resolveDataSource(source)] as const,
    ),
  );
  return {
    manifest,
    data: Object.fromEntries(entries),
  };
}

async function resolveDataSource(source: DashboardDataSource): Promise<unknown> {
  if (source.type === 'static') return source.data;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(source.url, {
      method: source.method ?? 'GET',
      ...(source.headers ? { headers: source.headers } : {}),
      ...(source.body === undefined ? {} : { body: JSON.stringify(source.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as unknown;
    return source.jsonPath ? pickPath(data, source.jsonPath) : data;
  } finally {
    clearTimeout(timeout);
  }
}

function pickPath(value: unknown, pathExpression: string): unknown {
  return pathExpression
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);
}

async function serveStatic(
  response: ServerResponse,
  staticDir: string,
  pathname: string,
): Promise<void> {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const relative = normalizedPath.replace(/^\/+/, '');
  if (relative.includes('..')) {
    writeJson(response, 403, { error: 'forbidden' });
    return;
  }
  const filePath = join(staticDir, relative);
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeType(filePath),
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    writeJson(response, 404, { error: 'not found' });
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw httpError(413, 'request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  });
  response.end(JSON.stringify(body));
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function mimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../static');
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function statusFromError(error: unknown): number {
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return typeof statusCode === 'number' ? statusCode : 500;
}
