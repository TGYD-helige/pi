import { createHash } from 'node:crypto';

/** Passive task transcripts must not enter the explicit, reusable Company store. */
export function automaticMemoryUserId(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const mode = env.MIRRORX_AUTOMATIC_MEMORY_SCOPE;
  if (!mode) return userId;
  if (mode === 'none') return null;
  if (mode !== 'task') throw new Error('Unsupported automatic memory scope');
  const company = env.AMASTER_EMPLOYEE_COMPANY_ID;
  const issue = env.AMASTER_RUNTIME_ISSUE_ID;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!company || !issue || !uuid.test(company) || !uuid.test(issue)) {
    throw new Error('Task automatic memory requires Company and Issue identity');
  }
  const hash = createHash('sha256')
    .update(JSON.stringify([userId, company, issue]))
    .digest('hex');
  return `mirrorx-task-memory-v1:${hash}`;
}
