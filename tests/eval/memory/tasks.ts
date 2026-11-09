export interface MemoryState {
  memory: string[];
  user: string[];
}
export interface MemoryTask {
  id: string;
  seed: MemoryState;
  sessions: string[];
  question: string;
  expected: Record<string, string | null>;
  required?: Partial<MemoryState>;
  forbidden?: string[];
  unchanged?: (keyof MemoryState)[];
  empty?: (keyof MemoryState)[];
  memoryCharLimit?: number;
}

export const MEMORY_TASKS: MemoryTask[] = [
  {
    id: 'recall-preference',
    seed: { memory: [], user: ['User prefers responses in Spanish.'] },
    sessions: [],
    question: 'Which response language does the user prefer? Set language to its English name.',
    expected: { language: 'Spanish' },
    required: { user: ['Spanish'] },
  },
  {
    id: 'correct-preference',
    seed: { memory: [], user: ['User prefers responses in Spanish.'] },
    sessions: [
      'My lasting response-language preference has changed to French. Update my saved preference, replacing the old one.',
    ],
    question:
      'Which response language does the user currently prefer? Set language to its English name.',
    expected: { language: 'French' },
    required: { user: ['French'] },
    forbidden: ['Spanish'],
  },
  {
    id: 'forget-address',
    seed: { memory: ['Shipping label is Dock-17.'], user: [] },
    sessions: [
      'Forget my shipping label entirely. Remove the saved label; do not retain a copy in another entry.',
    ],
    question: 'What shipping label is remembered? Use address as the key.',
    expected: { address: null },
    empty: ['memory', 'user'],
  },
  {
    id: 'project-scope',
    seed: { memory: ['Project Alpha uses npm test.', 'Project Beta uses pnpm test.'], user: [] },
    sessions: [],
    question: 'Give the exact test command for each project, using Alpha and Beta as keys.',
    expected: { Alpha: 'npm test', Beta: 'pnpm test' },
    unchanged: ['memory', 'user'],
  },
  {
    id: 'unknown-project',
    seed: { memory: ['Project Alpha uses npm test.'], user: [] },
    sessions: [],
    question: 'What is the known test command for project Gamma? Use command as the key.',
    expected: { command: null },
    unchanged: ['memory', 'user'],
  },
  {
    id: 'preserve-qualifiers',
    seed: { memory: ['Project Alpha uses npm test and deploys to eu-west-1.'], user: [] },
    sessions: [
      'Project Alpha now uses pnpm test. Save the correction; its deployment region is unchanged.',
    ],
    question:
      'Give the exact test command and deployment region for project Alpha, using command and region as keys.',
    expected: { command: 'pnpm test', region: 'eu-west-1' },
    required: { memory: ['Alpha', 'pnpm test', 'eu-west-1'] },
    forbidden: ['uses npm test'],
  },
  {
    id: 'duplicate-preference',
    seed: { memory: [], user: ['User prefers responses in Spanish.'] },
    sessions: ['Remember that my lasting response-language preference is Spanish.'],
    question: 'Which response language does the user prefer? Set language to its English name.',
    expected: { language: 'Spanish' },
    unchanged: ['memory', 'user'],
  },
  {
    id: 'skip-task-progress',
    seed: { memory: ['Project Alpha uses pnpm test.'], user: [] },
    sessions: [
      'Status update for this task: PR 999 was submitted and all 42 tests passed. Acknowledge this completed task update.',
    ],
    question: 'Give the exact test command for project Alpha, using command as the key.',
    expected: { command: 'pnpm test' },
    unchanged: ['memory', 'user'],
  },
  {
    id: 'avoid-inferred-preference',
    seed: { memory: [], user: [] },
    sessions: [
      'I tried Rust once this morning. I have not decided which programming language I prefer.',
    ],
    question:
      'Which programming language is established as the user preference? Use language as the key.',
    expected: { language: null },
    empty: ['memory', 'user'],
  },
  {
    id: 'capacity-preserves-facts',
    seed: {
      memory: ['Project Alpha deploys to eu-west-1.', 'Project Beta deploys to ap-south-1.'],
      user: [],
    },
    memoryCharLimit: 80,
    sessions: [
      'Save an additional project fact in MEMORY: Project Gamma uses a dedicated production environment in us-east-2 with its own independent nightly release pipeline. Keep all existing valid facts. If it cannot fit, report the capacity blocker instead of deleting facts or moving them into USER.',
    ],
    question:
      'Give the deployment regions for projects Alpha and Beta, using Alpha and Beta as keys.',
    expected: { Alpha: 'eu-west-1', Beta: 'ap-south-1' },
    required: { memory: ['Alpha', 'eu-west-1', 'Beta', 'ap-south-1'] },
    unchanged: ['user'],
  },
  {
    id: 'save-new-preference',
    seed: { memory: [], user: [] },
    sessions: ['Remember my lasting editor preference: Neovim.'],
    question: 'Which editor does the user prefer? Use editor as the key.',
    expected: { editor: 'Neovim' },
    required: { user: ['Neovim'] },
  },
  {
    id: 'selective-forgetting',
    seed: { memory: ['Project Alpha uses npm test.', 'Project Beta uses pnpm test.'], user: [] },
    sessions: [
      'Forget the saved test command for project Alpha. Keep the valid project Beta fact.',
    ],
    question: 'Give the known test commands for Alpha and Beta, using those names as keys.',
    expected: { Alpha: null, Beta: 'pnpm test' },
    required: { memory: ['Beta', 'pnpm test'] },
    forbidden: ['Alpha'],
  },
];

export function gradeMemoryTask(
  task: MemoryTask,
  answer: string,
  state: MemoryState,
  memoryEnabled = true,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== Object.keys(task.expected).length ||
    Object.entries(task.expected).some(([key, expected]) =>
      typeof expected === 'string' && typeof record[key] === 'string'
        ? record[key].trim().toLowerCase() !== expected.toLowerCase()
        : record[key] !== expected,
    )
  )
    return false;
  if (!memoryEnabled) return true;
  if (
    task.memoryCharLimit !== undefined &&
    state.memory.join('\n§\n').length > task.memoryCharLimit
  )
    return false;
  for (const target of ['memory', 'user'] as const) {
    if (task.empty?.includes(target) && state[target].length > 0) return false;
    const text = state[target].join('\n').toLowerCase();
    if (task.required?.[target]?.some((fact) => !text.includes(fact.toLowerCase()))) return false;
    if (
      task.unchanged?.includes(target) &&
      JSON.stringify(state[target]) !== JSON.stringify(task.seed[target])
    )
      return false;
  }
  const text = [...state.memory, ...state.user].join('\n').toLowerCase();
  return !task.forbidden?.some((fact) => text.includes(fact.toLowerCase()));
}
