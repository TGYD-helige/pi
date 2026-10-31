import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSessionClient, type SessionRecord, writeSessionRecord } from '../session-client.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), writeFile: vi.fn(actual.writeFile) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error('Unexpected worker startup');
    }),
  };
});

describe('BrowserSessionClient', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pi-browser-use-session-client-')));
    vi.stubEnv('PI_AGENT_HOME', root);
    vi.mocked(open).mockClear();
    vi.mocked(spawn).mockClear();
  });

  it('keeps the original worker writable and releasable across temporary homes', async () => {
    const shared = join(root, 'shared');
    const homeA = join(root, 'home-a');
    const homeB = join(root, 'home-b');
    await Promise.all([mkdir(shared), mkdir(homeA), mkdir(homeB)]);
    await symlink(shared, join(homeA, 'browser-sessions'));
    await symlink(shared, join(homeB, 'browser-sessions'));
    const config = { session: { enabled: true as const, key: 'shared-worker', retentionMs: 1000 } };
    let workerPath: string;
    let record: SessionRecord;
    const worker = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { action } = JSON.parse(body);
      try {
        if (action === 'retain') await writeSessionRecord(workerPath, record);
        if (action === 'release') await rm(workerPath);
        response.end(JSON.stringify({ result: { state: action } }));
      } catch {
        response.writeHead(500).end(JSON.stringify({ error: 'record path unavailable' }));
      }
    });
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
    const address = worker.address();
    if (!address || typeof address === 'string') throw new Error('No worker address');
    const child = new ChildProcess();
    child.send = vi.fn((message) => {
      const startup = message as unknown as { path: string; record: SessionRecord };
      workerPath = startup.path;
      record = { ...startup.record, port: address.port };
      void writeSessionRecord(workerPath, record).then(() =>
        child.emit('message', { ready: true }),
      );
      return true;
    });
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValueOnce(child);
    vi.stubEnv('PI_AGENT_HOME', homeA);
    const first = new BrowserSessionClient(config);
    let second: BrowserSessionClient | undefined;
    try {
      await first.connect();
      await first.control('retain');
      await first.close();
      await rm(homeA, { recursive: true });
      vi.stubEnv('PI_AGENT_HOME', homeB);
      second = new BrowserSessionClient(config);
      await second.connect();
      await expect(second.control('retain')).resolves.toEqual({ state: 'retain' });
      expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
      await expect(second.control('release')).resolves.toEqual({ state: 'release' });
      const directory = join(shared, createHash('sha256').update(config.session.key).digest('hex'));
      await expect(readFile(join(directory, 'session.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(directory, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await first.close();
      await second?.close();
      await new Promise<void>((resolve, reject) =>
        worker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('rejects a symlink at the session directory before starting a worker', async () => {
    const shared = join(root, 'target');
    const parent = join(root, 'browser-sessions');
    await mkdir(shared);
    await mkdir(parent);
    await symlink(shared, join(parent, createHash('sha256').update('unsafe').digest('hex')));
    const client = new BrowserSessionClient({
      session: { enabled: true, key: 'unsafe', retentionMs: 1000 },
    });
    await expect(client.connect()).rejects.toThrow('ownership is unsafe');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a session directory owned by another user',
    async () => {
      const uid = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
      try {
        const client = new BrowserSessionClient({
          session: { enabled: true, key: 'foreign-owner', retentionMs: 1000 },
        });
        await expect(client.connect()).rejects.toThrow('ownership is unsafe');
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        uid.mockRestore();
      }
    },
  );

  it('keeps a reconnected client alive when an older heartbeat fails later', async () => {
    const config = {
      session: { enabled: true as const, key: 'heartbeat-race', retentionMs: 1000 },
    };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update(config.session.key).digest('hex'),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, 'session.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        port: 12345,
      }),
      { mode: 0o600 },
    );
    const rejectHeartbeats: Array<(error: Error) => void> = [];
    let heartbeats = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { action } = JSON.parse(String(init?.body));
      if (action === 'heartbeat' && ++heartbeats <= 2) {
        return new Promise<Response>((_resolve, reject) => rejectHeartbeats.push(reject));
      }
      return Response.json({ result: {} });
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const client = new BrowserSessionClient(config);
    try {
      await client.connect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(heartbeats).toBe(2);
      rejectHeartbeats[0]!(new Error('first heartbeat connection failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getState()).toBe('disconnected');
      await client.connect();
      expect(client.getState()).toBe('ready');
      rejectHeartbeats[1]!(new Error('stale heartbeat connection failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getState()).toBe('ready');
      await vi.advanceTimersByTimeAsync(5000);
      expect(heartbeats).toBe(3);
    } finally {
      for (const reject of rejectHeartbeats) reject(new Error('test cleanup'));
      await client.close();
      vi.useRealTimers();
      fetch.mockRestore();
    }
  });

  it.each([
    'expired',
    'lost',
  ])('reports a %s browser without starting a replacement', async (ended) => {
    const config = { session: { enabled: true as const, key: 'ended-browser', retentionMs: 1000 } };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update(config.session.key).digest('hex'),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, 'session.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        ended,
      }),
      { mode: 0o600 },
    );
    await expect(new BrowserSessionClient(config).connect()).rejects.toThrow(
      ended === 'expired' ? 'expired' : 'lost',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('removes its initial record and preserves cancellation before spawning a worker', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before worker creation');
    const actualWrite =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await actualWrite.writeFile(...args);
      controller.abort(reason);
    });
    const config = { session: { enabled: true as const, key: 'cancel', retentionMs: 1000 } };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update('cancel').digest('hex'),
    );
    await expect(new BrowserSessionClient(config).connect(controller.signal)).rejects.toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
    await expect(readFile(join(directory, 'session.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(directory, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('observes cancellation that happened before installing the worker abort listener', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled while spawning');
    const child = new ChildProcess();
    child.send = vi.fn(() => true);
    child.kill = vi.fn(() => true);
    child.unref = vi.fn();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.mocked(spawn).mockImplementationOnce(() => {
      controller.abort(reason);
      return child;
    });
    const client = new BrowserSessionClient({
      session: { enabled: true, key: 'spawn-abort', retentionMs: 1000 },
    });
    await expect(client.connect(controller.signal)).rejects.toBe(reason);
    expect(child.send).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update('spawn-abort').digest('hex'),
    );
    await expect(readFile(join(directory, 'session.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(directory, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the startup fence after initialization was sent before cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled after worker initialization');
    const child = new ChildProcess();
    child.send = vi.fn(() => {
      controller.abort(reason);
      return true;
    });
    child.kill = vi.fn(() => true);
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValueOnce(child);
    const client = new BrowserSessionClient({
      session: { enabled: true, key: 'sent-abort', retentionMs: 1000 },
    });
    await expect(client.connect(controller.signal)).rejects.toBe(reason);
    expect(child.send).toHaveBeenCalledOnce();
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update('sent-abort').digest('hex'),
    );
    const record = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
    expect(record.token).toMatch(/^[a-f0-9]{64}$/);
    expect(record.port).toBeUndefined();
    await expect(readFile(join(directory, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    'unknown-provider-outcome',
    1,
    true,
  ])('preserves records with an invalid terminal state (%s)', async (ended) => {
    const config = { session: { enabled: true as const, key: 'invalid-ended', retentionMs: 1000 } };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update(config.session.key).digest('hex'),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const recordPath = join(directory, 'session.json');
    const original = JSON.stringify({ token: 'a'.repeat(64), configHash: 'previous', ended });
    await writeFile(recordPath, original, { mode: 0o600 });
    await expect(new BrowserSessionClient(config).control('release')).rejects.toThrow(
      'record is invalid',
    );
    expect(await readFile(recordPath, 'utf8')).toBe(original);
  });

  it('releases the filesystem lock before waiting for an existing worker to attach', async () => {
    const config = { session: { enabled: true as const, key: 'resume-lock', retentionMs: 1000 } };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update('resume-lock').digest('hex'),
    );
    const attached = deferred();
    const continueAttach = deferred();
    let owner: string | undefined;
    let attaches = 0;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.action === 'attach') {
        attaches++;
        if (owner && owner !== input.owner) {
          res
            .writeHead(409)
            .end('{"error":"This browser session is already in use by another client."}');
          return;
        }
        owner = input.owner;
        attached.resolve();
        await continueAttach.promise;
      }
      res.end('{"result":{}}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No worker address');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, 'session.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        port: address.port,
      }),
      { mode: 0o600 },
    );
    const first = new BrowserSessionClient(config);
    const second = new BrowserSessionClient(config);
    const startup = first.connect();
    try {
      await attached.promise;
      await expect(readFile(join(directory, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(second.connect(AbortSignal.timeout(1000))).rejects.toThrow('already in use');
      expect(attaches).toBe(2);
    } finally {
      continueAttach.resolve();
      await startup;
      await first.close();
      await second.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resumes a protected binding without reinjection and rejects a different instance', async () => {
    const config = {
      session: {
        enabled: true as const,
        key: 'runtime-bound',
        retentionMs: 1000,
        backend: { release: { url: 'http://localhost/stop/{sessionId}' } },
      },
    };
    const binding = {
      id: 'private-instance',
      connection: { wsEndpoint: 'ws://localhost:9222/existing' },
    };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update(config.session.key).digest('hex'),
    );
    const actions: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      actions.push(JSON.parse(Buffer.concat(chunks).toString()).action);
      res.end('{"result":{}}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, 'session.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        port: address.port,
        configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        binding,
      }),
      { mode: 0o600 },
    );
    const client = new BrowserSessionClient(config);
    try {
      await client.connect();
      await client.close();
      await expect(
        new BrowserSessionClient(config, { ...binding, id: 'another-instance' }).connect(),
      ).rejects.toThrow('binding changed');
      expect(actions).toEqual(['attach', 'detach']);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('requires runtime injection for a new existing-instance session without creating a record', async () => {
    const config = {
      session: {
        enabled: true as const,
        key: 'missing-runtime',
        retentionMs: 1000,
        backend: { release: { url: 'http://localhost/stop/{sessionId}' } },
      },
    };
    await expect(new BrowserSessionClient(config).connect()).rejects.toThrow(
      'runtime browser binding is required',
    );
    const path = join(
      root,
      'browser-sessions',
      createHash('sha256').update(config.session.key).digest('hex'),
      'session.json',
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'startup-failed',
    'cleanup-failed',
    undefined,
  ])('preserves an uncertain provider record (%s)', async (ended) => {
    const config = { session: { enabled: true as const, key: 'uncertain', retentionMs: 1000 } };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update('uncertain').digest('hex'),
    );
    const recordPath = join(directory, 'session.json');
    const record = { token: 'a'.repeat(64), configHash: 'previous', ended };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    await expect(new BrowserSessionClient(config).control('release')).rejects.toThrow('uncertain');
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(record)),
    );
    await expect(readFile(join(directory, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for startup and preserves a replacement record when releasing an ended session', async () => {
    const config = { session: { enabled: true as const, key: 'handoff', retentionMs: 1000 } };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update('handoff').digest('hex'),
    );
    const recordPath = join(directory, 'session.json');
    const lockPath = join(directory, 'lock');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      recordPath,
      JSON.stringify({ token: 'a'.repeat(64), configHash: 'old', ended: 'expired' }),
      { mode: 0o600 },
    );
    await writeFile(lockPath, '', { mode: 0o600 });
    const actions: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { action } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      actions.push(action);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { state: 'active' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    const client = new BrowserSessionClient(config);
    try {
      const releasing = client.control('release');
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith(lockPath, 'wx', 0o600));
      const replacement = {
        token: 'b'.repeat(64),
        configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        port: address.port,
      };
      await writeFile(recordPath, JSON.stringify(replacement), { mode: 0o600 });
      await rm(lockPath);
      await expect(releasing).resolves.toEqual({ state: 'active' });
      expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(replacement);
      expect(actions).toEqual(['attach', 'release']);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    false,
    true,
  ])('detaches once when close overlaps startup (lost attach response: %s)', async (loseResponse) => {
    const config = { session: { enabled: true as const, key: 'shutdown', retentionMs: 1000 } };
    const directory = join(
      root,
      'browser-sessions',
      createHash('sha256').update('shutdown').digest('hex'),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const attached = deferred();
    const continueAttach = deferred();
    const actions: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { action } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      actions.push(action);
      if (action === 'attach') {
        attached.resolve();
        await continueAttach.promise;
        if (loseResponse) {
          req.socket.destroy();
          return;
        }
      }
      res.end(JSON.stringify({ result: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server address');
    await writeFile(
      join(directory, 'session.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        port: address.port,
      }),
      { mode: 0o600 },
    );
    const client = new BrowserSessionClient(config);
    const startup = client.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await attached.promise;
      const repeatedStartup = client.connect().catch(() => undefined);
      const closing = client.close();
      const repeatedClose = client.close();
      await expect(client.connect()).rejects.toThrow('closing');
      continueAttach.resolve();
      await Promise.all([startup, repeatedStartup]);
      await Promise.all([closing, repeatedClose]);
      expect(client.getState()).toBe('disconnected');
      expect(actions).toEqual(['attach', 'detach']);
      await client.close();
      expect(actions).toEqual(['attach', 'detach']);
    } finally {
      continueAttach.resolve();
      await startup;
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
