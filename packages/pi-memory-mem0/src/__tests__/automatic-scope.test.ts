import { describe, expect, it } from 'vitest';
import { automaticMemoryUserId } from '../automatic-scope.js';

describe('automatic memory scope', () => {
  const env = {
    MIRRORX_AUTOMATIC_MEMORY_SCOPE: 'task',
    AMASTER_EMPLOYEE_COMPANY_ID: '55598358-ef7e-4acd-b5ac-c3d1730666d3',
    AMASTER_RUNTIME_ISSUE_ID: '1fdf4704-c76f-4583-938a-e288a9410237',
  };
  it('isolates tasks and companies but retains the same scope across run/workspace changes', () => {
    const scope = automaticMemoryUserId('company', env);
    expect(scope).not.toBe(
      automaticMemoryUserId('company', {
        ...env,
        AMASTER_RUNTIME_ISSUE_ID: '25d4fdef-641e-4a7f-8d5d-737b07b60929',
      }),
    );
    expect(scope).not.toBe(
      automaticMemoryUserId('company', {
        ...env,
        AMASTER_EMPLOYEE_COMPANY_ID: '25d4fdef-641e-4a7f-8d5d-737b07b60929',
      }),
    );
    expect(scope).toBe(
      automaticMemoryUserId('company', { ...env, AMASTER_RUNTIME_RUN_ID: 'new-run', PWD: '/new' }),
    );
  });
  it('preserves ordinary Pi defaults and fails closed on invalid governed scope', () => {
    expect(automaticMemoryUserId('company', {})).toBe('company');
    expect(automaticMemoryUserId('company', { MIRRORX_AUTOMATIC_MEMORY_SCOPE: 'none' })).toBeNull();
    expect(() =>
      automaticMemoryUserId('company', { ...env, AMASTER_RUNTIME_ISSUE_ID: '' }),
    ).toThrow('identity');
    expect(() =>
      automaticMemoryUserId('company', { MIRRORX_AUTOMATIC_MEMORY_SCOPE: 'other' }),
    ).toThrow('scope');
  });
});
