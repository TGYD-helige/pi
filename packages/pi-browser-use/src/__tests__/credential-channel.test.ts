import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { BrowserCredentialAuthority } from '../credential-auth.js';
import {
  BrowserCredentialChannelClient,
  decodeCredentialFrame,
  encodeCredentialFrame,
} from '../credential-channel.js';

const authority: BrowserCredentialAuthority = {
  version: 1,
  companyId: '00000000-0000-4000-8000-000000000001',
  issueId: '00000000-0000-4000-8000-000000000002',
  runId: '22222222-2222-4222-8222-222222222222',
  commandId: '33333333-3333-4333-8333-333333333333',
  interactionId: '11111111-1111-4111-8111-111111111111',
  credentialKey: 'browser.password',
  credentialVersion: 1,
  credentialRole: 'password',
  targetOrigin: 'https://login.example.com',
  authenticationOrigin: 'https://login.example.com',
  bindingId: '44444444-4444-4444-8444-444444444444',
  browserLeaseId: 'browser-credential-auth-write-55555555-5555-4555-8555-555555555555',
};

describe('BrowserCredentialChannelClient', () => {
  it('uses challenge-bound framing and returns a private value once', async () => {
    const responses = new PassThrough();
    const requests = new PassThrough();
    const client = new BrowserCredentialChannelClient(responses, requests);
    const requestChunks: Buffer[] = [];
    requests.on('data', (chunk) => requestChunks.push(Buffer.from(chunk)));

    responses.write(encodeCredentialFrame('C', Buffer.from('challenge')));
    const pending = client.resolve(authority);
    await new Promise((resolve) => setImmediate(resolve));

    const request = decodeCredentialFrame(Buffer.concat(requestChunks));
    expect(request.type).toBe('R');
    expect(JSON.parse(request.payload.toString('utf8'))).toMatchObject({
      challenge: 'challenge',
      credentialKey: 'browser.password',
      controlSemantic: 'password',
    });

    responses.write(encodeCredentialFrame('V', Buffer.from('sentinel-password')));
    await expect(pending).resolves.toEqual(Buffer.from('sentinel-password'));
    client.recordAuthenticated(
      authority,
      { origin: 'https://login.example.com', pageGeneration: 'clean-generation' },
      ['password'],
    );
    await new Promise((resolve) => setImmediate(resolve));
    const allFrames = Buffer.concat(requestChunks);
    const firstFrameLength = requestChunks[0]?.length ?? 0;
    const receipt = decodeCredentialFrame(allFrames.subarray(firstFrameLength));
    expect(receipt.type).toBe('A');
    expect(JSON.parse(receipt.payload.toString('utf8'))).toMatchObject({
      status: 'authenticated',
      contextRotated: true,
      credentialRoles: ['password'],
    });
    await expect(client.resolve(authority)).rejects.toThrow(
      'browser_credential_ref_already_consumed',
    );
    client.close();
  });

  it('rejects oversized frames without returning their content', () => {
    expect(() => encodeCredentialFrame('V', Buffer.alloc(16 * 1024 + 1))).toThrow(
      'browser_credential_frame_too_large',
    );
  });

  it('closes the private channel on cancellation before a value arrives', async () => {
    const responses = new PassThrough();
    const requests = new PassThrough();
    const client = new BrowserCredentialChannelClient(responses, requests);
    const controller = new AbortController();
    responses.write(encodeCredentialFrame('C', Buffer.from('challenge')));

    const pending = client.resolve(authority, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow('browser_credential_request_aborted');
    await expect(client.resolve(authority)).rejects.toThrow('browser_credential_channel_closed');
  });
});
