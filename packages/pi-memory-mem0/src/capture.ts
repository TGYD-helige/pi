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
  private deferred: CapturedTurn[] = [];
  private live = new WeakSet<CapturedTurn>();
  private warnedHistorical = false;
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
    private writeTimeoutMs = 120_000,
    private archive?: (turns: CapturedTurn[]) => void,
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
    if (provider.supportsObservationDates === false) {
      this.deferred = this.pending;
      this.pending = [];
    }
  }

  private warnHistorical(): void {
    if (this.deferred.length && !this.warnedHistorical) {
      this.warnedHistorical = true;
      this.notify?.(
        'Self-hosted historical observation dates are unsupported. Pending historical turns are retained for manual recovery; live capture continues.',
      );
    }
  }

  private persist(pending: CapturedTurn[]): void {
    this.save([...this.deferred, ...pending]);
  }

  start(): void {
    this.warnHistorical();
    if (this.deferred.length && this.archive) {
      this.archive([...this.deferred]);
      this.save([...this.pending]);
      this.deferred = [];
    }
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
      this.pending.length + this.deferred.length >= MAX_PENDING_TURNS ||
      turn.messages.reduce((size, message) => size + message.content.length, 0) > MAX_TURN_CHARS
    )
      return false;
    if (signal) this.callerSignals.set(turn, signal);
    this.live.add(turn);
    this.pending.push(turn);
    try {
      this.persist(this.pending);
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
        const lifetime = AbortSignal.any([this.controller.signal, ...(caller ? [caller] : [])]);
        // Waiting for an old uncancellable write does not consume a new extraction's budget.
        if (this.state.active)
          await waitWithCancellation(
            this.state.active.catch(() => {}),
            lifetime,
          );
        lifetime.throwIfAborted();
        const age = Date.now() - Date.parse(turn.observedAt);
        const freshSelfHosted =
          this.provider.supportsObservationDates === false &&
          this.live.has(turn) &&
          age >= 0 &&
          new Date(turn.observedAt).toISOString().slice(0, 10) ===
            new Date().toISOString().slice(0, 10);
        if (this.provider.supportsObservationDates === false && !freshSelfHosted) {
          const remaining = this.pending.slice(1);
          const deferred = [...this.deferred, turn];
          if (this.archive) {
            this.archive([turn]);
            this.persist(remaining);
          } else {
            this.save([...deferred, ...remaining]);
            this.deferred = deferred;
          }
          this.pending = remaining;
          if (!this.warnedHistorical) {
            this.notify?.(
              'A cross-day capture was archived for manual recovery; newer live captures continue.',
            );
            this.warnedHistorical = true;
          }
          continue;
        }
        const deadline = new AbortController();
        const timer = setTimeout(
          () => deadline.abort(new Error('Memory capture timed out.')),
          this.writeTimeoutMs,
        );
        timer.unref();
        const signal = AbortSignal.any([lifetime, deadline.signal]);
        const state = this.state;
        let result: Awaited<ReturnType<Mem0Provider['add']>>;
        try {
          const operation = this.provider
            .add(turn.messages, {
              ...this.scope,
              ...(freshSelfHosted ? {} : { observedAt: turn.observedAt }),
              timeoutMs: this.writeTimeoutMs,
              ...(this.provider.supportsAddCancellation ? { signal } : {}),
            })
            .finally(() => {
              if (state.active === operation) delete state.active;
            });
          state.active = operation;
          try {
            result = await waitWithCancellation(operation, signal);
          } catch (error) {
            if (
              !deadline.signal.aborted ||
              lifetime.aborted ||
              this.provider.supportsAddCancellation
            )
              throw error;
            this.notify?.('Memory extraction is still running; new captures remain queued.');
            result = await waitWithCancellation(operation, lifetime);
          }
        } finally {
          clearTimeout(timer);
        }
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
        this.persist(remaining);
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
