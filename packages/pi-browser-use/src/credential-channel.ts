import { createReadStream, createWriteStream, fstatSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { BrowserCredentialAuthority } from './credential-auth.js';

const REQUEST_FD = 5;
const RESPONSE_FD = 6;
const MAX_BYTES = 16 * 1024;
const PRIVATE_CHANNEL_MARKER = 'AMASTER_BROWSER_CREDENTIAL_PRIVATE_CHANNEL';

type CredentialFrame = { type: 'A' | 'C' | 'E' | 'R' | 'V'; payload: Buffer };

export function encodeCredentialFrame(type: CredentialFrame['type'], payload: Buffer): Buffer {
  if (payload.length > MAX_BYTES) throw new Error('browser_credential_frame_too_large');
  return Buffer.concat([Buffer.from(`${type}${payload.length}\n`, 'ascii'), payload]);
}

export function decodeCredentialFrame(input: Buffer): CredentialFrame {
  const newline = input.indexOf(0x0a);
  if (newline < 0) throw new Error('browser_credential_frame_incomplete');
  const match = /^([ACERV])([0-9]{1,6})$/u.exec(input.subarray(0, newline).toString('ascii'));
  if (!match) throw new Error('browser_credential_frame_invalid');
  const length = Number(match[2]);
  if (length > MAX_BYTES) throw new Error('browser_credential_frame_too_large');
  if (input.length !== newline + 1 + length) throw new Error('browser_credential_frame_incomplete');
  return { type: match[1] as CredentialFrame['type'], payload: input.subarray(newline + 1) };
}

export function browserCredentialPrivateChannelAvailable(): boolean {
  if (process.env[PRIVATE_CHANNEL_MARKER] !== '1') return false;
  try {
    fstatSync(REQUEST_FD);
    fstatSync(RESPONSE_FD);
    return true;
  } catch {
    return false;
  }
}

export class BrowserCredentialChannelClient {
  private buffer = Buffer.alloc(0);
  private challenge?: string;
  private challengeWaiters: Array<{
    resolve: (challenge: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private responseWaiter:
    | {
        resolve: (value: Buffer) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private consumed = new Set<string>();
  private closed = false;

  static fromProcess(): BrowserCredentialChannelClient {
    if (!browserCredentialPrivateChannelAvailable()) {
      throw new Error('browser_credential_private_fd_unavailable');
    }
    return new BrowserCredentialChannelClient(
      createReadStream('', { fd: RESPONSE_FD, autoClose: false }),
      createWriteStream('', { fd: REQUEST_FD, autoClose: false }),
    );
  }

  constructor(
    responses: Readable,
    private readonly requests: Writable,
  ) {
    responses.on('data', (chunk) => this.onData(Buffer.from(chunk)));
    responses.on('error', () => this.fail('browser_credential_channel_failed'));
    responses.on('end', () => this.fail('browser_credential_channel_closed'));
  }

  async resolve(authority: BrowserCredentialAuthority, signal?: AbortSignal): Promise<Buffer> {
    if (this.closed) throw new Error('browser_credential_channel_closed');
    const key = `${authority.credentialKey}:${authority.credentialVersion}:${authority.credentialRole}`;
    if (this.consumed.has(key)) throw new Error('browser_credential_ref_already_consumed');
    if (this.responseWaiter) throw new Error('browser_credential_request_in_progress');
    const challenge = await this.waitForChallenge(signal);
    if (signal?.aborted) {
      this.fail('browser_credential_request_aborted');
      throw new Error('browser_credential_request_aborted');
    }
    this.consumed.add(key);
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        challenge,
        interactionId: authority.interactionId,
        credentialKey: authority.credentialKey,
        credentialVersion: authority.credentialVersion,
        credentialRole: authority.credentialRole,
        runId: authority.runId,
        commandId: authority.commandId,
        bindingId: authority.bindingId,
        targetOrigin: authority.targetOrigin,
        authenticationOrigin: authority.authenticationOrigin,
        controlSemantic: authority.credentialRole === 'password' ? 'password' : 'username',
      }),
      'utf8',
    );
    const frame = encodeCredentialFrame('R', payload);
    payload.fill(0);
    const response = new Promise<Buffer>((resolve, reject) => {
      this.responseWaiter = { resolve, reject };
    });
    this.requests.write(frame, () => frame.fill(0));
    const abort = () => this.fail('browser_credential_request_aborted');
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await response;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  recordAuthenticated(
    authority: BrowserCredentialAuthority,
    proof: { pageGeneration: string; origin: string },
    credentialRoles: BrowserCredentialAuthority['credentialRole'][],
  ): void {
    if (this.closed) throw new Error('browser_credential_channel_closed');
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        status: 'authenticated',
        runId: authority.runId,
        commandId: authority.commandId,
        interactionId: authority.interactionId,
        bindingId: authority.bindingId,
        origin: proof.origin,
        pageGeneration: proof.pageGeneration,
        contextRotated: true,
        credentialRoles: [...new Set(credentialRoles)].sort(),
      }),
      'utf8',
    );
    const frame = encodeCredentialFrame('A', payload);
    payload.fill(0);
    this.requests.write(frame, () => frame.fill(0));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.fill(0);
    this.buffer = Buffer.alloc(0);
    this.responseWaiter?.reject(new Error('browser_credential_channel_closed'));
    this.responseWaiter = undefined;
    for (const waiter of this.challengeWaiters.splice(0)) {
      waiter.reject(new Error('browser_credential_channel_closed'));
    }
  }

  private waitForChallenge(signal?: AbortSignal): Promise<string> {
    if (this.challenge) return Promise.resolve(this.challenge);
    if (signal?.aborted) return Promise.reject(new Error('browser_credential_request_aborted'));
    let abort: (() => void) | undefined;
    const waiting = new Promise<string>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.challengeWaiters.push(waiter);
      abort = () => {
        this.challengeWaiters = this.challengeWaiters.filter((candidate) => candidate !== waiter);
        this.fail('browser_credential_request_aborted');
        reject(new Error('browser_credential_request_aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
    return waiting.finally(() => signal?.removeEventListener('abort', abort!));
  }

  private onData(chunk: Buffer): void {
    if (this.closed) {
      chunk.fill(0);
      return;
    }
    const previous = this.buffer;
    this.buffer = Buffer.concat([previous, chunk]);
    previous.fill(0);
    chunk.fill(0);
    if (this.buffer.length > MAX_BYTES * 3) {
      this.fail('browser_credential_frame_too_large');
      return;
    }
    while (this.consumeOneFrame()) {
      // Drain complete frames; partial data remains buffered.
    }
  }

  private consumeOneFrame(): boolean {
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) return false;
    const match = /^([ACERV])([0-9]{1,6})$/u.exec(
      this.buffer.subarray(0, newline).toString('ascii'),
    );
    if (!match) return this.fail('browser_credential_frame_invalid');
    const length = Number(match[2]);
    if (length > MAX_BYTES) return this.fail('browser_credential_frame_too_large');
    const end = newline + 1 + length;
    if (this.buffer.length < end) return false;
    const payload = Buffer.from(this.buffer.subarray(newline + 1, end));
    const previous = this.buffer;
    this.buffer = Buffer.from(previous.subarray(end));
    previous.fill(0);
    this.handleFrame(match[1] as CredentialFrame['type'], payload);
    return true;
  }

  private handleFrame(type: CredentialFrame['type'], payload: Buffer): void {
    if (type === 'C' && !this.challenge) {
      this.challenge = payload.toString('utf8');
      payload.fill(0);
      for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(this.challenge);
      return;
    }
    const waiter = this.responseWaiter;
    this.responseWaiter = undefined;
    if (!waiter || (type !== 'V' && type !== 'E')) {
      payload.fill(0);
      this.fail('browser_credential_response_invalid');
      return;
    }
    if (type === 'E') {
      const reason = safeChannelError(payload.toString('utf8'));
      payload.fill(0);
      waiter.reject(new Error(reason));
      return;
    }
    waiter.resolve(payload);
  }

  private fail(reason: string): false {
    const waiter = this.responseWaiter;
    this.close();
    waiter?.reject(new Error(reason));
    return false;
  }
}

function safeChannelError(value: string): string {
  return /^browser_credential_[a-z0-9_]{1,64}$/u.test(value)
    ? value
    : 'browser_credential_consume_failed';
}
