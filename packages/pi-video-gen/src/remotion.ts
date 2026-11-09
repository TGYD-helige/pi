import {
  type ProjectSpec,
  parseProjectSpec,
  preflightProject,
  runProject,
} from './project-render.js';

export type RemotionSpec = ProjectSpec & { compositionId: string };

export const parseRemotionSpec = (raw: string): RemotionSpec =>
  parseProjectSpec(raw, 'remotion') as RemotionSpec;
export const preflightRemotion = (
  opts: Omit<Parameters<typeof preflightProject>[0], 'spec' | 'engine'> & { spec: RemotionSpec },
) => preflightProject({ ...opts, engine: 'remotion' });
export const runRemotion = (opts: Omit<Parameters<typeof runProject>[0], 'engine'>) =>
  runProject({ ...opts, engine: 'remotion' });
