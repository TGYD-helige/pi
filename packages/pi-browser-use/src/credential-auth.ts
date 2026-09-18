export type BrowserCredentialRole = 'username' | 'password';

export interface BrowserCredentialAuthority {
  version: 1;
  companyId: string;
  issueId: string;
  interactionId: string;
  credentialKey: string;
  credentialVersion: number;
  credentialRole: BrowserCredentialRole;
  runId: string;
  commandId: string;
  bindingId: string;
  targetOrigin: string;
  authenticationOrigin: string;
  browserLeaseId: string;
}

export interface BrowserCredentialAuthInput {
  pageId: number;
  pageGeneration: string;
  usernameValue?: string;
  credentialRefs: BrowserCredentialAuthority[];
}

export interface BrowserCredentialPreflightInput {
  pageId: number;
  targetOrigin: string;
}

export type BrowserCredentialPreflight =
  | { status: 'ready'; pageGeneration: string; origin: string }
  | { status: 'handoff'; reason: string };

export type BrowserToolResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

export type CredentialResolver = (
  authority: BrowserCredentialAuthority,
  signal?: AbortSignal,
) => Promise<Buffer> | Buffer;
export type TrustedToolCaller = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<BrowserToolResult>;

const CREDENTIAL_MARKER =
  /(?:\[credentialKey:[^\]\s]+\]|\bbrowser-credential-ref:\S+\b|\bbrowser_credential_ref:\S+\b)/iu;
const ORDINARY_TEXT_WRITERS = new Set(['fill', 'fill_form', 'type_text']);

export class BrowserCredentialGate {
  private phase: 'open' | 'sealed' | 'credential_bound' | 'closed' = 'open';
  private boundOrigin?: string;
  private boundPageId?: number;

  seal(): void {
    if (this.phase !== 'open') throw new Error('browser_auth_transaction_unavailable');
    this.phase = 'sealed';
  }

  bindCredentialSession(origin: string, pageId: number): void {
    if (this.phase !== 'sealed') throw new Error('browser_auth_transaction_unavailable');
    this.phase = 'credential_bound';
    this.boundOrigin = exactHttpsOrigin(origin);
    this.boundPageId = pageId;
  }

  close(): void {
    this.phase = 'closed';
  }

  releasePreflight(): void {
    if (this.phase !== 'sealed') throw new Error('browser_auth_transaction_unavailable');
    this.phase = 'open';
  }

  isSealed(): boolean {
    return this.phase === 'sealed';
  }

  isCredentialBound(): boolean {
    return this.phase === 'credential_bound';
  }

  currentPhase(): 'open' | 'sealed' | 'credential_bound' | 'closed' {
    return this.phase;
  }

  assertCredentialSession(pageId: number, origin?: unknown): string {
    if (
      this.phase !== 'credential_bound' ||
      this.boundOrigin === undefined ||
      this.boundPageId !== pageId
    ) {
      throw new Error('browser_credential_session_not_bound');
    }
    if (origin !== undefined && origin !== this.boundOrigin) {
      throw new Error('browser_credential_session_origin_mismatch');
    }
    return this.boundOrigin;
  }

  assertGenericAllowed(name: string, args: Record<string, unknown>): void {
    if (this.phase === 'sealed') throw new Error('browser_auth_transaction_sealed');
    if (this.phase === 'closed') throw new Error('browser_credential_session_closed');
    if (this.phase === 'credential_bound') {
      throw new Error('browser_credential_session_tool_forbidden');
    }
    if (ORDINARY_TEXT_WRITERS.has(name) && containsCredentialMarker(args)) {
      throw new Error('browser_credential_handle_requires_auth_transaction');
    }
  }
}

export class BrowserCredentialAuthTransaction {
  constructor(
    private readonly dependencies: {
      gate: BrowserCredentialGate;
      resolveCredential: CredentialResolver;
      callTrustedTool: TrustedToolCaller;
      destroyBrowser: () => Promise<void>;
    },
  ) {}

  async preflight(
    input: BrowserCredentialPreflightInput,
    signal?: AbortSignal,
  ): Promise<BrowserCredentialPreflight> {
    const result = await this.dependencies.callTrustedTool(
      'evaluate_script',
      {
        pageId: input.pageId,
        function: PREFLIGHT_FUNCTION,
        args: [],
      },
      signal,
    );
    const proof = parseBrowserJson(result);
    if (proof.status === 'handoff') {
      return { status: 'handoff', reason: safeReason(proof.reason) };
    }
    if (
      proof.status !== 'ready' ||
      proof.origin !== input.targetOrigin ||
      typeof proof.pageGeneration !== 'string' ||
      proof.pageGeneration.length < 1
    ) {
      return { status: 'handoff', reason: 'origin_or_page_generation_mismatch' };
    }
    return {
      status: 'ready',
      pageGeneration: proof.pageGeneration,
      origin: proof.origin,
    };
  }

  async authenticate(
    input: BrowserCredentialAuthInput,
    signal?: AbortSignal,
  ): Promise<{ status: 'authenticated'; pageGeneration: string; origin: string }> {
    const credentials: Partial<Record<BrowserCredentialRole, Buffer>> = {};
    let handoffReason: string | undefined;
    let destructiveStarted = false;
    this.dependencies.gate.seal();
    try {
      const origins = validateAuthorities(input.credentialRefs);
      const hasUsernameRef = input.credentialRefs.some(
        (authority) => authority.credentialRole === 'username',
      );
      let publicUsername: string | undefined;
      try {
        publicUsername = validatePublicUsername(input.usernameValue, hasUsernameRef);
      } catch {
        handoffReason = hasUsernameRef ? 'username_value_ambiguous' : 'username_value_required';
        throw new Error('browser_auth_preflight_handoff');
      }
      if (origins.targetOrigin !== origins.authenticationOrigin) {
        handoffReason = 'cross_origin_authentication_unsupported';
        throw new Error('browser_auth_preflight_handoff');
      }
      const targetOrigin = origins.authenticationOrigin;
      const preflight = await this.preflight(
        {
          pageId: input.pageId,
          targetOrigin,
        },
        signal,
      );
      if (preflight.status === 'handoff') {
        handoffReason = preflight.reason;
        throw new Error('browser_auth_preflight_handoff');
      }
      if (preflight.pageGeneration !== input.pageGeneration) {
        handoffReason = 'stale_page_generation';
        throw new Error('browser_auth_preflight_handoff');
      }

      destructiveStarted = true;
      try {
        await this.dependencies.callTrustedTool(
          'evaluate_script',
          { pageId: input.pageId, function: ROTATE_BEFORE_CONSUME_FUNCTION, args: [] },
          signal,
        );
      } catch {
        // Expected when the hard reload destroys the model-observed document context.
      }
      if (signal?.aborted) throw new Error('browser_auth_transaction_aborted');
      const privatePreflight = parseBrowserJson(
        await this.dependencies.callTrustedTool(
          'evaluate_script',
          { pageId: input.pageId, function: PREFLIGHT_FUNCTION, args: [] },
          signal,
        ),
      );
      if (
        privatePreflight.status !== 'ready' ||
        privatePreflight.origin !== targetOrigin ||
        typeof privatePreflight.pageGeneration !== 'string' ||
        privatePreflight.pageGeneration === input.pageGeneration
      ) {
        handoffReason = safeReason(privatePreflight.reason ?? 'private_preflight_mismatch');
        throw new Error('browser_auth_preflight_handoff');
      }

      for (const authority of input.credentialRefs) {
        const value = await this.dependencies.resolveCredential(authority, signal);
        if (!Buffer.isBuffer(value) || value.length < 1 || value.length > 16 * 1024) {
          value?.fill(0);
          throw new Error('browser_credential_value_invalid');
        }
        credentials[authority.credentialRole] = value;
      }

      try {
        await this.dependencies.callTrustedTool(
          'evaluate_script',
          {
            pageId: input.pageId,
            function: authFunction(privatePreflight.pageGeneration, credentials, publicUsername),
            args: [],
          },
          signal,
        );
      } catch {
        // A real document navigation destroys the old execution context and rejects the MCP call.
        // The fixed proof below decides whether that interruption was a successful rotation.
      }
      if (signal?.aborted) throw new Error('browser_auth_transaction_aborted');

      const proof = parseBrowserJson(
        await this.dependencies.callTrustedTool(
          'evaluate_script',
          { pageId: input.pageId, function: PROOF_FUNCTION, args: [] },
          signal,
        ),
      );
      if (
        proof.status !== 'authenticated' ||
        proof.origin !== targetOrigin ||
        typeof proof.pageGeneration !== 'string' ||
        proof.pageGeneration === input.pageGeneration
      ) {
        throw new Error('browser_auth_transaction_unproven');
      }
      this.dependencies.gate.bindCredentialSession(proof.origin, input.pageId);
      return {
        status: 'authenticated',
        pageGeneration: proof.pageGeneration,
        origin: proof.origin,
      };
    } catch {
      if (handoffReason && !destructiveStarted) {
        this.dependencies.gate.releasePreflight();
      } else {
        this.dependencies.gate.close();
        await this.dependencies.destroyBrowser();
      }
      if (handoffReason) throw new Error(`human_session_handoff:${handoffReason}`);
      throw new Error('browser_auth_transaction_failed');
    } finally {
      for (const value of Object.values(credentials)) value?.fill(0);
    }
  }
}

function validatePublicUsername(value: unknown, hasUsernameRef: boolean): string | undefined {
  if (hasUsernameRef) {
    if (value !== undefined) throw new Error('browser_credential_username_ambiguous');
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error('browser_credential_username_required');
  }
  return value;
}

function containsCredentialMarker(value: unknown): boolean {
  if (typeof value === 'string') return CREDENTIAL_MARKER.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialMarker);
  if (value && typeof value === 'object')
    return Object.values(value).some(containsCredentialMarker);
  return false;
}

function validateAuthorities(authorities: BrowserCredentialAuthority[]): {
  targetOrigin: string;
  authenticationOrigin: string;
} {
  if (authorities.length < 1 || authorities.length > 2) {
    throw new Error('browser_credential_authority_invalid');
  }
  const passwordCount = authorities.filter(
    (authority) => authority.credentialRole === 'password',
  ).length;
  const usernameCount = authorities.filter(
    (authority) => authority.credentialRole === 'username',
  ).length;
  if (passwordCount !== 1 || usernameCount > 1)
    throw new Error('browser_credential_authority_invalid');
  const [first] = authorities;
  if (!first) throw new Error('browser_credential_authority_invalid');
  const identity = [
    first.companyId,
    first.issueId,
    first.runId,
    first.commandId,
    first.interactionId,
    first.bindingId,
  ];
  for (const authority of authorities) {
    if (
      authority.version !== 1 ||
      authority.targetOrigin !== first.targetOrigin ||
      authority.authenticationOrigin !== first.authenticationOrigin ||
      !authority.browserLeaseId.startsWith('browser-credential-auth-write-') ||
      [
        authority.companyId,
        authority.issueId,
        authority.runId,
        authority.commandId,
        authority.interactionId,
        authority.bindingId,
      ].some((value, index) => value !== identity[index])
    ) {
      throw new Error('browser_credential_authority_invalid');
    }
  }
  return {
    targetOrigin: exactHttpsOrigin(first.targetOrigin),
    authenticationOrigin: exactHttpsOrigin(first.authenticationOrigin),
  };
}

function exactHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      value !== url.origin
    ) {
      throw new Error('browser_credential_origin_invalid');
    }
    return url.origin;
  } catch {
    throw new Error('browser_credential_origin_invalid');
  }
}

function safeReason(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/u.test(value)
    ? value
    : 'semantic_mismatch';
}

const PREFLIGHT_FUNCTION = `async () => {
  const handoff = (reason) => ({ status: 'handoff', reason });
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  if (globalThis.top !== globalThis) return handoff('cross_origin_or_iframe_authentication');
  const passwords = [...document.querySelectorAll('input[type="password"][autocomplete="current-password"]')]
    .filter((element) => element.isConnected && visible(element) && !element.disabled && !element.readOnly);
  if (passwords.length !== 1) return handoff('password_control_ambiguous');
  const password = passwords[0];
  const form = password.form;
  if (!form) return handoff('form_relation_mismatch');
  const usernames = [...form.querySelectorAll('input[autocomplete="username"],input[autocomplete="email"]')]
    .filter((element) => element.isConnected && visible(element) && !element.disabled && !element.readOnly && ['text', 'email'].includes(element.type));
  if (usernames.length !== 1) return handoff('username_control_ambiguous');
  const submits = [...form.querySelectorAll('button,input')]
    .filter((element) => element.isConnected && visible(element) && !element.disabled && element.type === 'submit');
  if (submits.length !== 1) return handoff('submit_control_ambiguous');
  globalThis.__mirrorxAuthPageGeneration ||= crypto.randomUUID();
  return { status: 'ready', pageGeneration: globalThis.__mirrorxAuthPageGeneration, origin: location.origin };
}`;

const ROTATE_BEFORE_CONSUME_FUNCTION = `async () => {
  location.reload();
  return { status: 'rotation_started' };
}`;

function authFunction(
  pageGeneration: string,
  credentials: Partial<Record<BrowserCredentialRole, Buffer>>,
  publicUsername?: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      pageGeneration,
      username:
        credentials.username?.toString('base64') ??
        (publicUsername === undefined
          ? null
          : Buffer.from(publicUsername, 'utf8').toString('base64')),
      password: credentials.password?.toString('base64') ?? null,
    }),
    'utf8',
  ).toString('base64');
  return `async () => {
    const privateInput = JSON.parse(atob(${JSON.stringify(payload)}));
    const decode = (value) => value === null ? null : new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
    if (globalThis.__mirrorxAuthPageGeneration !== privateInput.pageGeneration) throw new Error('stale_page_generation');
    const usernameSecret = decode(privateInput.username);
    const passwordSecret = decode(privateInput.password);
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const passwordControls = [...document.querySelectorAll('input[type="password"][autocomplete="current-password"]')]
      .filter((element) => element.isConnected && visible(element) && !element.disabled && !element.readOnly);
    if (passwordControls.length !== 1) throw new Error('password_control_ambiguous');
    const password = passwordControls[0];
    const form = password.form;
    if (!form) throw new Error('form_relation_mismatch');
    const usernameControls = [...form.querySelectorAll('input[autocomplete="username"],input[autocomplete="email"]')]
      .filter((element) => element.isConnected && visible(element) && !element.disabled && !element.readOnly && ['text', 'email'].includes(element.type));
    const submitControls = [...form.querySelectorAll('button,input')]
      .filter((element) => element.isConnected && visible(element) && !element.disabled && element.type === 'submit');
    if (usernameControls.length !== 1 || submitControls.length !== 1) throw new Error('form_relation_mismatch');
    const username = usernameControls[0];
    const submit = submitControls[0];
    const setNativeValue = (element, value) => {
      const ownSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
      const prototypeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
      const setter = prototypeSetter && ownSetter !== prototypeSetter ? prototypeSetter : ownSetter || prototypeSetter;
      if (!setter) throw new Error('control_value_setter_missing');
      setter.call(element, value);
    };
    try {
      if (usernameSecret !== null) setNativeValue(username, usernameSecret);
      setNativeValue(password, passwordSecret);
      for (const element of [username, password]) {
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const form = password.form;
      if (!form || username.form !== form) throw new Error('form_relation_mismatch');
      form.requestSubmit(submit);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && password.isConnected) await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      if (password.isConnected) setNativeValue(password, '');
      if (usernameSecret !== null && username.isConnected) setNativeValue(username, '');
    }
    location.reload();
    return { status: 'rotation_started' };
  }`;
}

const PROOF_FUNCTION = `async () => {
  globalThis.__mirrorxAuthPageGeneration ||= crypto.randomUUID();
  const hasPassword = [...document.querySelectorAll('input[type="password"]')].some((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return element.isConnected && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  });
  return {
    status: hasPassword ? 'unauthenticated' : 'authenticated',
    pageGeneration: globalThis.__mirrorxAuthPageGeneration,
    origin: location.origin,
  };
}`;

export function parseBrowserJson(result: BrowserToolResult): Record<string, unknown> {
  if (result.isError) throw new Error('browser_auth_transaction_failed');
  const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '';
  const fenced = /```json\s*([\s\S]*?)\s*```/u.exec(text)?.[1];
  if (!fenced) throw new Error('browser_auth_transaction_unproven');
  const parsed = JSON.parse(fenced) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('browser_auth_transaction_unproven');
  }
  return parsed as Record<string, unknown>;
}
