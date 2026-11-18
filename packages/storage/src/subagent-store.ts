/**
 * JSON-file store for subagent run lifecycle state.
 *
 * Owns parent/child run records, status transitions, depth/count queries, and
 * lifecycle event history. It does not execute subagent turns or enforce tool
 * exposure policy.
 */
import { randomUUID } from 'node:crypto';
import type {
  RuntimeScope,
  SubagentRun,
  SubagentRunStatus,
  SubagentRunStore,
} from '@amaster.ai/pi-shared';
import { readJsonFile, writeJsonFile } from './json-file.js';

type SubagentRunCreateInput = Parameters<SubagentRunStore['create']>[0];

export class JsonFileSubagentRunStore implements SubagentRunStore {
  private loaded = false;
  private runs = new Map<string, SubagentRun>();
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async create(input: SubagentRunCreateInput): Promise<SubagentRun> {
    return await this.update((runs) => {
      const now = new Date().toISOString();
      const runId = randomUUID();
      const run: SubagentRun = {
        runId,
        taskRunId: input.taskRunId ?? runId,
        ...(input.spawnBatchId ? { spawnBatchId: input.spawnBatchId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
        ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
        task: input.task,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.label ? { label: input.label } : {}),
        status: 'pending',
        depth: input.depth,
        model: input.model,
        toolPolicyProfile: input.toolPolicyProfile,
        context: input.context,
        createdAt: now,
        updatedAt: now,
        events: [
          { type: 'subagent_spawning', at: now },
          { type: 'subagent_spawned', at: now },
        ],
      };
      runs.set(run.runId, run);
      return run;
    });
  }

  async list(_scope: RuntimeScope, parentSessionId?: string): Promise<SubagentRun[]> {
    await this.load();
    const runs = [...this.runs.values()];
    return parentSessionId ? runs.filter((run) => run.parentSessionId === parentSessionId) : runs;
  }

  async get(_scope: RuntimeScope, runId: string): Promise<SubagentRun | undefined> {
    await this.load();
    return this.runs.get(runId);
  }

  async getDepthForSession(_scope: RuntimeScope, sessionId: string): Promise<number> {
    await this.load();
    const run = [...this.runs.values()].find((candidate) => candidate.childSessionId === sessionId);
    return run?.depth ?? 0;
  }

  async countActiveChildren(_scope: RuntimeScope, parentSessionId: string): Promise<number> {
    await this.load();
    return [...this.runs.values()].filter(
      (run) => run.parentSessionId === parentSessionId && isActiveSubagentStatus(run.status),
    ).length;
  }

  markRunning(_scope: RuntimeScope, runId: string): Promise<SubagentRun | undefined> {
    return this.patch(runId, (run, now) => ({
      ...run,
      status: 'running',
      startedAt: run.startedAt ?? now,
      updatedAt: now,
      events: [...run.events, { type: 'subagent_started', at: now }],
    }));
  }

  markCompleted(
    _scope: RuntimeScope,
    runId: string,
    result: string,
  ): Promise<SubagentRun | undefined> {
    return this.patch(runId, (run, now) => {
      if (run.status === 'cancelled') {
        return run;
      }
      return {
        ...omitSubagentError(run),
        status: 'completed',
        result,
        endedAt: now,
        updatedAt: now,
        events: [...run.events, { type: 'subagent_ended', at: now, reason: 'completed' }],
      };
    });
  }

  markFailed(_scope: RuntimeScope, runId: string, error: string): Promise<SubagentRun | undefined> {
    return this.patch(runId, (run, now) => {
      if (run.status === 'cancelled') {
        return run;
      }
      return {
        ...run,
        status: 'failed',
        error,
        endedAt: now,
        updatedAt: now,
        events: [...run.events, { type: 'subagent_ended', at: now, reason: 'failed' }],
      };
    });
  }

  markCancelled(
    _scope: RuntimeScope,
    runId: string,
    reason = 'cancelled',
  ): Promise<SubagentRun | undefined> {
    return this.patch(runId, (run, now) => {
      if (isTerminalSubagentStatus(run.status)) {
        return run;
      }
      return {
        ...run,
        status: 'cancelled',
        error: reason,
        endedAt: now,
        updatedAt: now,
        events: [...run.events, { type: 'subagent_ended', at: now, reason: 'cancelled' }],
      };
    });
  }

  private async patch(
    runId: string,
    mutator: (run: SubagentRun, now: string) => SubagentRun,
  ): Promise<SubagentRun | undefined> {
    return await this.update((runs) => {
      const run = runs.get(runId);
      if (!run) {
        return undefined;
      }
      const next = mutator(run, new Date().toISOString());
      runs.set(runId, next);
      return next;
    });
  }

  private async update<T>(mutator: (runs: Map<string, SubagentRun>) => T): Promise<T> {
    const pending = this.writeTail.then(async () => {
      await this.load();
      // Mutate a copy so a failed write leaves readers on the last persisted state.
      const draft = new Map(this.runs);
      const result = mutator(draft);
      await writeJsonFile(this.filePath, [...draft.values()]);
      this.runs = draft;
      return result;
    });
    this.writeTail = pending.catch(() => undefined);
    return await pending;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const runs = await readJsonFile<SubagentRun[]>(this.filePath, []);
    this.runs = new Map(runs.map((run) => [run.runId, run]));
    this.loaded = true;
  }
}

export function isActiveSubagentStatus(status: SubagentRunStatus): boolean {
  return status === 'pending' || status === 'running';
}

export function isTerminalSubagentStatus(status: SubagentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function omitSubagentError(run: SubagentRun): Omit<SubagentRun, 'error'> {
  const { error: _error, ...rest } = run;
  return rest;
}
