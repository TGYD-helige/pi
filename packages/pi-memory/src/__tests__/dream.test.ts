import { existsSync, rmSync } from 'node:fs';
import { mkdir, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDream } from '../dream.js';
import { writeDreamingState } from '../dreaming-state.js';

const { runConsolidationMock, metadata, openFile } = vi.hoisted(() => ({
  runConsolidationMock: vi.fn(),
  metadata: vi.fn(),
  openFile: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  metadata.mockImplementation(actual.stat);
  openFile.mockImplementation(actual.open);
  return { ...actual, stat: metadata, open: openFile };
});

vi.mock('../consolidation.js', () => ({
  runConsolidation: runConsolidationMock,
}));

describe('runDream', () => {
  let home: string;
  let sessionDir: string;
  let session: SessionManager;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    metadata.mockClear();
    openFile.mockClear();
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    home = path.join(tmpdir(), 'pi-memory-dream-test');
    rmSync(home, { recursive: true, force: true });
    process.env.PI_CODING_AGENT_DIR = path.join(home, 'pi-agent');
    sessionDir = path.join(home, 'sessions');
    session = SessionManager.create(home, sessionDir, { id: 'dream-test' });
    appendTurn(session, 1);
    runConsolidationMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('skips history discovery when the consolidation model is unavailable', async () => {
    const registry = modelRegistry();
    registry.find.mockReturnValue(undefined as never);

    await expect(
      runDream({ memoryDir: path.join(home, 'memories'), modelRegistry: registry, sessionDir }),
    ).resolves.toBe(false);
    expect(metadata).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(runConsolidationMock).not.toHaveBeenCalled();
  });

  it('skips history when the model exists but credentials are unavailable', async () => {
    const registry = modelRegistry();
    registry.getApiKeyAndHeaders.mockResolvedValue({ ok: false, apiKey: '' });
    await expect(
      runDream({ memoryDir: path.join(home, 'memories'), modelRegistry: registry, sessionDir }),
    ).resolves.toBe(false);
    expect(metadata).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(runConsolidationMock).not.toHaveBeenCalled();
  });

  it('opens only the 32 newest files after filtering their metadata', async () => {
    const base = Date.now();
    for (let i = 0; i < 35; i++) {
      const recent = SessionManager.create(home, sessionDir, { id: `window-${i}` });
      appendTurn(recent, i);
      await utimes(recent.getSessionFile()!, new Date(base + i + 1000), new Date(base + i + 1000));
    }
    await expect(
      runDream({
        dreaming: { minTurnsSinceLastRun: 1 },
        memoryDir: path.join(home, 'memories'),
        modelRegistry: modelRegistry(),
        sessionDir,
      }),
    ).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledTimes(32);
    const turns = runConsolidationMock.mock.calls[0]![0].turns;
    expect(turns).toHaveLength(32);
    expect(turns.some((turn: { sessionId: string }) => turn.sessionId === 'window-0')).toBe(false);
    expect(turns.some((turn: { sessionId: string }) => turn.sessionId === 'window-34')).toBe(true);
  });

  it('reads a bounded tail and follows the active branch after a large old entry', async () => {
    session.appendMessage({ role: 'user', content: 'x'.repeat(400_000), timestamp: Date.now() });
    appendTurn(session, 2);
    const branchPoint = session.getLeafId()!;
    appendTurn(session, 3);
    session.branch(branchPoint);
    appendTurn(session, 4);
    const bytes: number[] = [];
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    openFile.mockImplementationOnce(async (file: string, flags: string) => {
      const handle = await actual.open(file, flags);
      const read = vi.spyOn(handle, 'read');
      const close = handle.close.bind(handle);
      handle.close = async () => {
        for (const call of read.mock.calls) {
          const args: readonly unknown[] = call;
          bytes.push(Number(args[2]));
        }
        await close();
      };
      return handle;
    });
    await expect(
      runDream({
        dreaming: { minTurnsSinceLastRun: 1 },
        memoryDir: path.join(home, 'memories'),
        modelRegistry: modelRegistry(),
        sessionDir,
      }),
    ).resolves.toBe(true);
    expect(bytes).toEqual([256 * 1024, 64 * 1024]);
    expect(
      runConsolidationMock.mock.calls[0]![0].turns.map(
        (turn: { userMessage: string }) => turn.userMessage,
      ),
    ).toEqual(['Remember preference 2', 'Remember preference 4']);
  });

  it('does not start a header read after a cancelled tail read eventually settles', async () => {
    session.appendMessage({ role: 'user', content: 'x'.repeat(400_000), timestamp: Date.now() });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    openFile.mockImplementationOnce(async (file: string, flags: string) => {
      const handle = await actual.open(file, flags);
      const read = vi.spyOn(handle, 'read');
      read.mockImplementationOnce(async () => {
        markStarted();
        await blocked;
        return { bytesRead: 0, buffer: Buffer.alloc(0) };
      });
      const close = handle.close.bind(handle);
      handle.close = async () => {
        reads = read.mock.calls.length;
        await close();
      };
      return handle;
    });
    const controller = new AbortController();
    const memoryDir = path.join(home, 'memories');
    const pending = runDream({
      dreaming: { minTurnsSinceLastRun: 1 },
      memoryDir,
      modelRegistry: modelRegistry(),
      sessionDir,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).resolves.toBe(false);
    finish();
    await vi.waitFor(() => expect(existsSync(`${memoryDir}.lock`)).toBe(false));
    expect(reads).toBe(1);
    expect(runConsolidationMock).not.toHaveBeenCalled();
  });

  it.each([
    'caller',
    'deadline',
  ])('ends the %s wait but holds the lock until stalled metadata settles', async (kind) => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const result = await actual.stat(session.getSessionFile()!);
    let finish!: (value: typeof result) => void;
    metadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    if (kind === 'deadline')
      vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
    const options = {
      dreaming: { minTurnsSinceLastRun: 1 },
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    };
    const pending = runDream({
      ...options,
      ...(kind === 'caller' ? { signal: controller.signal } : {}),
    });
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).resolves.toBe(false);
    await expect(runDream(options)).resolves.toBe(false);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(openFile).not.toHaveBeenCalled();
    finish(result);
    await vi.waitFor(() => expect(existsSync(`${options.memoryDir}.lock`)).toBe(false));
    expect(openFile).not.toHaveBeenCalled();
    await expect(runDream(options)).resolves.toBe(true);
  });

  it('reads default Pi sessions across project directories', async () => {
    const projectA = SessionManager.create(path.join(home, 'project-a'), undefined, {
      id: 'project-a',
    });
    const projectB = SessionManager.create(path.join(home, 'project-b'), undefined, {
      id: 'project-b',
    });
    appendTurn(projectA, 1);
    appendTurn(projectB, 2);

    await expect(
      runDream({
        dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 2 },
        includeGlobalSessions: true,
        memoryDir: path.join(home, 'global-memories'),
        modelRegistry: modelRegistry(),
        sessionDir: projectA.getSessionDir(),
      }),
    ).resolves.toBe(true);

    expect(runConsolidationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: expect.arrayContaining([
          expect.objectContaining({ sessionId: 'project-a' }),
          expect.objectContaining({ sessionId: 'project-b' }),
        ]),
      }),
    );
  });

  it('discovers symlink project directories in the global session root', async () => {
    const root = path.join(home, 'pi-agent', 'sessions');
    await mkdir(root, { recursive: true });
    await symlink(sessionDir, path.join(root, 'linked-project'), 'dir');
    await expect(
      runDream({
        dreaming: { minTurnsSinceLastRun: 1 },
        includeGlobalSessions: true,
        memoryDir: path.join(home, 'memories'),
        modelRegistry: modelRegistry(),
      }),
    ).resolves.toBe(true);
    expect(runConsolidationMock.mock.calls[0]![0].turns[0].sessionId).toBe('dream-test');
  });

  it('keeps a custom memory store scoped to its current session directory', async () => {
    const otherProject = SessionManager.create(path.join(home, 'other-project'), undefined, {
      id: 'other-project',
    });
    appendTurn(otherProject, 2);

    await expect(
      runDream({
        dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 1 },
        memoryDir: path.join(home, 'isolated-memories'),
        modelRegistry: modelRegistry(),
        sessionDir,
      }),
    ).resolves.toBe(true);

    expect(runConsolidationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [expect.objectContaining({ sessionId: 'dream-test' })],
      }),
    );
  });

  it('reads Pi sessions, runs once, and skips while the time gate is closed', async () => {
    const options = {
      dreaming: { minHoursSinceLastRun: 24, minTurnsSinceLastRun: 1 },
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    };

    await expect(runDream(options)).resolves.toBe(true);
    await expect(runDream(options)).resolves.toBe(false);

    expect(runConsolidationMock).toHaveBeenCalledTimes(1);
    expect(runConsolidationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          expect.objectContaining({
            assistantMessage: 'Understood',
            sessionId: 'dream-test',
            userMessage: 'Remember preference 1',
          }),
        ],
      }),
    );
  });

  it('skips while the turns gate is closed', async () => {
    const result = await runDream({
      dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 2 },
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    });

    expect(result).toBe(false);
    expect(runConsolidationMock).not.toHaveBeenCalled();
  });

  it('defaults to a five-turn gate', async () => {
    const options = {
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    };

    for (let index = 2; index <= 4; index++) appendTurn(session, index);
    await expect(runDream(options)).resolves.toBe(false);

    appendTurn(session, 5);
    await expect(runDream(options)).resolves.toBe(true);
  });

  it('defaults to a 24-hour time gate', async () => {
    const memoryDir = path.join(home, 'memories');
    for (let index = 2; index <= 6; index++) appendTurn(session, index, Date.now());

    await writeDreamingState(
      {
        lastConsolidatedAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
        lastSessionCount: 0,
      },
      memoryDir,
    );
    await expect(runDream({ memoryDir, modelRegistry: modelRegistry(), sessionDir })).resolves.toBe(
      false,
    );

    await writeDreamingState(
      {
        lastConsolidatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        lastSessionCount: 0,
      },
      memoryDir,
    );
    await expect(runDream({ memoryDir, modelRegistry: modelRegistry(), sessionDir })).resolves.toBe(
      true,
    );
  });

  it('skips a concurrent session while another dream holds the lock', async () => {
    let finish: ((value: boolean) => void) | undefined;
    runConsolidationMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const options = {
      dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 1 },
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    };

    const first = runDream(options);
    await vi.waitFor(() => expect(runConsolidationMock).toHaveBeenCalledTimes(1));
    await expect(runDream(options)).resolves.toBe(false);
    finish?.(true);
    await expect(first).resolves.toBe(true);

    expect(runConsolidationMock).toHaveBeenCalledTimes(1);
  });
});

function modelRegistry() {
  return {
    find: vi.fn(() => ({ id: 'test-model' })),
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test' }),
  };
}

function appendTurn(session: SessionManager, index: number, timestamp = Date.parse('2020-01-01')) {
  session.appendMessage({
    role: 'user',
    content: `Remember preference ${index}`,
    timestamp,
  });
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Understood' }],
    provider: 'test',
    model: 'test-model',
    timestamp,
  } as never);
}
