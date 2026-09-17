import { describe, expect, it, vi } from 'vitest';
import {
  type BrowserCredentialAuthority,
  BrowserCredentialAuthTransaction,
  BrowserCredentialGate,
} from '../credential-auth.js';

const passwordAuthority: BrowserCredentialAuthority = {
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

const authInput = {
  pageId: 7,
  pageGeneration: 'page-generation-1',
  usernameValue: 'qa@example.com',
  credentialRefs: [passwordAuthority],
};

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
      },
    ],
  };
}

describe('BrowserCredentialGate', () => {
  it('blocks every generic command while sealed and keeps dangerous reads blocked after auth', () => {
    const gate = new BrowserCredentialGate();
    expect(gate.currentPhase()).toBe('open');
    gate.seal();
    expect(gate.currentPhase()).toBe('sealed');

    for (const name of [
      'evaluate_script',
      'take_snapshot',
      'take_screenshot',
      'get_network_request',
    ]) {
      expect(() => gate.assertGenericAllowed(name, {})).toThrow('browser_auth_transaction_sealed');
    }

    gate.bindCredentialSession('https://login.example.com', 7);
    expect(gate.currentPhase()).toBe('credential_bound');
    expect(() => gate.assertGenericAllowed('evaluate_script', {})).toThrow(
      'browser_credential_session_tool_forbidden',
    );
    expect(() => gate.assertGenericAllowed('take_snapshot', {})).toThrow(
      'browser_credential_session_tool_forbidden',
    );
    expect(gate.assertCredentialSession(7, 'https://login.example.com')).toBe(
      'https://login.example.com',
    );
    expect(() => gate.assertCredentialSession(7, 'https://evil.example.com')).toThrow(
      'browser_credential_session_origin_mismatch',
    );
  });

  it('rejects credential handles passed to ordinary fill and type tools before dispatch', () => {
    const gate = new BrowserCredentialGate();

    for (const name of ['fill', 'fill_form', 'type_text']) {
      expect(() =>
        gate.assertGenericAllowed(name, {
          value: '[credentialKey:browser.password]',
        }),
      ).toThrow('browser_credential_handle_requires_auth_transaction');
    }
  });
});

describe('BrowserCredentialAuthTransaction', () => {
  it('checks semantic/origin/page-generation state before consuming a credential', async () => {
    const gate = new BrowserCredentialGate();
    const resolveCredential = vi.fn(() => Buffer.from('sentinel-password'));
    const callTrustedTool = vi.fn(async () =>
      jsonResult({ status: 'handoff', reason: 'password_autocomplete_mismatch' }),
    );
    const destroyBrowser = vi.fn(async () => undefined);
    const transaction = new BrowserCredentialAuthTransaction({
      gate,
      resolveCredential,
      callTrustedTool,
      destroyBrowser,
    });

    await expect(transaction.authenticate(authInput)).rejects.toThrow(
      'human_session_handoff:password_autocomplete_mismatch',
    );
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(callTrustedTool).toHaveBeenCalledTimes(1);
    expect(callTrustedTool).toHaveBeenCalledWith(
      'evaluate_script',
      expect.objectContaining({ args: [] }),
      undefined,
    );
    expect(destroyBrowser).toHaveBeenCalledOnce();
  });

  it('hands cross-origin authority to a human before consume', async () => {
    const resolveCredential = vi.fn(() => Buffer.from('sentinel-password'));
    const callTrustedTool = vi.fn();
    const transaction = new BrowserCredentialAuthTransaction({
      gate: new BrowserCredentialGate(),
      resolveCredential,
      callTrustedTool,
      destroyBrowser: vi.fn(async () => undefined),
    });

    await expect(
      transaction.authenticate({
        ...authInput,
        credentialRefs: [{ ...passwordAuthority, targetOrigin: 'https://app.example.com' }],
      }),
    ).rejects.toThrow('human_session_handoff:cross_origin_authentication_unsupported');
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(callTrustedTool).not.toHaveBeenCalled();
  });

  it('requires a public username before consume when no username ref exists', async () => {
    const resolveCredential = vi.fn(() => Buffer.from('sentinel-password'));
    const transaction = new BrowserCredentialAuthTransaction({
      gate: new BrowserCredentialGate(),
      resolveCredential,
      callTrustedTool: vi.fn(),
      destroyBrowser: vi.fn(async () => undefined),
    });

    await expect(
      transaction.authenticate({
        pageId: authInput.pageId,
        pageGeneration: authInput.pageGeneration,
        credentialRefs: authInput.credentialRefs,
      }),
    ).rejects.toThrow('human_session_handoff:username_value_required');
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('seals generic browser commands before credential resolution completes', async () => {
    const gate = new BrowserCredentialGate();
    let releaseCredential!: (value: Buffer) => void;
    const resolveCredential = vi.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          releaseCredential = resolve;
        }),
    );
    const callTrustedTool = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResult({
          status: 'ready',
          pageGeneration: 'page-generation-1',
          origin: 'https://login.example.com',
        }),
      )
      .mockResolvedValueOnce(jsonResult({ status: 'rotation_started' }))
      .mockResolvedValueOnce(
        jsonResult({
          status: 'ready',
          pageGeneration: 'private-generation',
          origin: 'https://login.example.com',
        }),
      )
      .mockResolvedValueOnce(jsonResult({ status: 'rotation_started' }))
      .mockResolvedValueOnce(
        jsonResult({
          status: 'authenticated',
          pageGeneration: 'clean-generation',
          origin: 'https://login.example.com',
        }),
      );
    const transaction = new BrowserCredentialAuthTransaction({
      gate,
      resolveCredential,
      callTrustedTool,
      destroyBrowser: vi.fn(async () => undefined),
    });

    const pending = transaction.authenticate(authInput);

    await vi.waitFor(() => expect(resolveCredential).toHaveBeenCalledOnce());
    expect(() => gate.assertGenericAllowed('evaluate_script', {})).toThrow(
      'browser_auth_transaction_sealed',
    );
    releaseCredential(Buffer.from('sentinel-password', 'utf8'));

    await expect(pending).resolves.toMatchObject({
      status: 'authenticated',
      pageGeneration: 'clean-generation',
    });
    expect(callTrustedTool).toHaveBeenCalledTimes(5);
    const publicEvidence = JSON.stringify(
      callTrustedTool.mock.calls.map(([name, args]) => ({
        name,
        pageId: args.pageId,
        argUids: args.args,
      })),
    );
    expect(publicEvidence).not.toContain('sentinel-password');
  });

  it('destroys the browser and returns a stable error when rotation proof fails', async () => {
    const secret = Buffer.from('sentinel-password');
    const gate = new BrowserCredentialGate();
    const destroyBrowser = vi.fn(async () => undefined);
    const transaction = new BrowserCredentialAuthTransaction({
      gate,
      resolveCredential: vi.fn(() => secret),
      callTrustedTool: vi
        .fn()
        .mockResolvedValueOnce(
          jsonResult({
            status: 'ready',
            pageGeneration: 'page-generation-1',
            origin: 'https://login.example.com',
          }),
        )
        .mockResolvedValueOnce(jsonResult({ status: 'rotation_started' }))
        .mockResolvedValueOnce(
          jsonResult({
            status: 'ready',
            pageGeneration: 'private-generation',
            origin: 'https://login.example.com',
          }),
        )
        .mockResolvedValueOnce(jsonResult({ status: 'rotation_started' }))
        .mockResolvedValueOnce(jsonResult({ status: 'unauthenticated' })),
      destroyBrowser,
    });

    await expect(transaction.authenticate(authInput)).rejects.toThrow(
      'browser_auth_transaction_failed',
    );
    expect(destroyBrowser).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });
});
