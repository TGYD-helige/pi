import { loadPiSettings } from '@amaster.ai/pi-shared/settings';

const SETTINGS_KEY = 'pi-goal';

/** Model used for deriving and evaluating goal conditions. */
export type GoalModelConfig = {
  provider: string;
  model: string;
};

export type PiGoalConfig = {
  /**
   * Model for deriving conditions and evaluating whether they are met.
   * Omit to disable the automatic engine — `/goal <condition>` still works
   * for setting a goal, but nothing auto-derives or auto-evaluates.
   */
  model?: GoalModelConfig;
  /** Max continuation rounds before the engine stops pushing. Default 10. */
  maxIterations?: number;
  /** Optional hard token budget; goal becomes budget_limited once exceeded. Omit for no limit. */
  tokenBudget?: number;
  /** Max chars of transcript fed to derive/evaluate. Default 8000. */
  transcriptMaxChars?: number;
  /** Ask the user to confirm a derived condition in TUI mode. Default true. */
  requireConfirmForDerived?: boolean;
};

export type ResolvedGoalConfig = {
  model?: GoalModelConfig;
  maxIterations: number;
  tokenBudget?: number;
  transcriptMaxChars: number;
  requireConfirmForDerived: boolean;
};

export const DEFAULTS = {
  maxIterations: 10,
  transcriptMaxChars: 8000,
  requireConfirmForDerived: true,
} as const;

export function resolveConfig(raw?: PiGoalConfig): ResolvedGoalConfig {
  const resolved: ResolvedGoalConfig = {
    maxIterations: sanitizePositiveInt(raw?.maxIterations, DEFAULTS.maxIterations),
    transcriptMaxChars: sanitizePositiveInt(raw?.transcriptMaxChars, DEFAULTS.transcriptMaxChars),
    requireConfirmForDerived: raw?.requireConfirmForDerived ?? DEFAULTS.requireConfirmForDerived,
  };
  if (isValidModel(raw?.model)) {
    resolved.model = { provider: raw.model.provider, model: raw.model.model };
  }
  if (
    typeof raw?.tokenBudget === 'number' &&
    Number.isFinite(raw.tokenBudget) &&
    raw.tokenBudget > 0
  ) {
    resolved.tokenBudget = Math.floor(raw.tokenBudget);
  }
  return resolved;
}

export function loadSettings(cwd: string, projectTrusted = false): PiGoalConfig | undefined {
  const config = loadPiSettings<Partial<PiGoalConfig>>(SETTINGS_KEY, { cwd, projectTrusted });
  return Object.keys(config).length > 0 ? (config as PiGoalConfig) : undefined;
}

function isValidModel(model: GoalModelConfig | undefined): model is GoalModelConfig {
  return (
    !!model &&
    typeof model.provider === 'string' &&
    model.provider.trim().length > 0 &&
    typeof model.model === 'string' &&
    model.model.trim().length > 0
  );
}

function sanitizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}
