import {
  getAddResult,
  type Mem0Provider,
  UnsupportedObservationDateError,
  waitWithCancellation,
} from './provider.js';

export interface CapturedTurn {
  messages: Array<{ role: string; content: string }>;
  observedAt: string;
}

export interface CaptureState {
  active?: Promise<unknown>;
}

const MAX_PENDING_TURNS = 16;
const MAX_TURN_CHARS = 64_000;

/** Session entries are the durable outbox; only one bounded snapshot lives in memory. */
export class CaptureQueue {
  private pending: CapturedTurn[];
  private closed = false;
  private running = false;
  private paused = false;
  private controller = new AbortController();
  private callerSignals = new WeakMap<CapturedTurn, AbortSignal>();

  constructor(
    private provider: Mem0Provider,
    private scope: { userId: string; agentId?: string },
    private state: CaptureState,
    private save: (pending: CapturedTurn[]) => void,
    restored: CapturedTurn[] = [],
    private notify?: (message: string) => void,
  ) {
    this.pending = restored
      .slice(0, MAX_PENDING_TURNS)
      .filter(
        (turn) =>
          turn &&
          typeof turn.observedAt === 'string' &&
          !Number.isNaN(Date.parse(turn.observedAt)) &&
          Array.isArray(turn.messages) &&
          turn.messages.length === 2 &&
          turn.messages.every(
            (message) =>
              message &&
              (message.role === 'user' || message.role === 'assistant') &&
              typeof message.content === 'string',
          ) &&
          turn.messages.reduce((size, message) => size + message.content.length, 0) <=
            MAX_TURN_CHARS,
      );
  }

  start(): void {
    if (this.running || this.closed || this.paused || this.pending.length === 0) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      this.start();
    });
  }

  enqueue(turn: CapturedTurn, signal?: AbortSignal): boolean {
    if (
      this.closed ||
      this.pending.length >= MAX_PENDING_TURNS ||
      turn.messages.reduce((size, message) => size + message.content.length, 0) > MAX_TURN_CHARS
    )
      return false;
    if (signal) this.callerSignals.set(turn, signal);
    this.pending.push(turn);
    try {
      this.save([...this.pending]);
    } catch (error) {
      this.pending.pop();
      throw error;
    }
    this.start();
    return true;
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed && this.pending.length > 0) {
        const turn = this.pending[0]!;
        const caller = this.callerSignals.get(turn);
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(5_000),
          ...(caller ? [caller] : []),
        ]);
        // Embedded add cannot be cancelled. Keep the raw operation single-flight across sessions.
        if (this.state.active)
          await waitWithCancellation(
            this.state.active.catch(() => {}),
            signal,
          );
        signal.throwIfAborted();
        const state = this.state;
        const operation = this.provider
          .add(turn.messages, {
            ...this.scope,
            observedAt: turn.observedAt,
            ...(this.provider.supportsAddCancellation ? { signal } : {}),
          })
          .finally(() => {
            if (state.active === operation) delete state.active;
          });
        state.active = operation;
        const result = await waitWithCancellation(operation, signal);
        if (this.closed) return;
        const { message, isError, writeStatus } = getAddResult(result);
        if (
          message &&
          (isError || writeStatus === 'unknown' || process.env.DEBUG?.includes('pi-memory-mem0'))
        ) {
          console.error(`[pi-memory-mem0] turn capture: ${message}`);
        }
        if (isError || writeStatus === 'unknown') {
          this.paused = true;
          return;
        }
        const remaining = this.pending.slice(1);
        this.save(remaining);
        this.pending = remaining;
      }
    } catch (error) {
      this.paused = true;
      if (!this.closed) {
        const message =
          error instanceof UnsupportedObservationDateError
            ? `${error.message} Pending turns remain in the session outbox.`
            : 'Capture paused; pending turns remain in the session outbox.';
        console.error(`[pi-memory-mem0] ${message}`);
        this.notify?.(message);
      }
    }
  }
}
