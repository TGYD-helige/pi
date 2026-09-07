// Trusted evaluation-only tools. Candidate skills are data, never executable code.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });

export function readSkillReference(root, requestedPath) {
  if (!root) throw new Error('No skill loaded');
  const base = realpathSync(root);
  const file = realpathSync(path.resolve(base, requestedPath));
  const relative = path.relative(base, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.md')) {
    throw new Error('Only Markdown inside the loaded skill is readable');
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 50_000) throw new Error('Reference exceeds the read limit');
  const content = readFileSync(file, 'utf8');
  if (content.split('\n').length > 2000) throw new Error('Reference exceeds the line limit');
  return content;
}

export default function skillEvalTools(pi) {
  const root = process.env.SKILL_EVAL_SKILL_DIR;
  pi.registerTool({
    name: 'read', label: 'Read skill reference',
    description: 'Read a Markdown file from the loaded skill directory. Use this to read matching skills and their linked references.',
    parameters: object({ path: string }, ['path']),
    async execute(_id, args) {
      try { return text(readSkillReference(root, args.path)); }
      catch { return { ...text('Reference unavailable or outside the loaded skill'), isError: true }; }
    },
  });
  if (process.env.SKILL_EVAL_MODE !== 'tools') return;

  const definitions = [
    ['image_generate', 'Generate or edit a bitmap with the active model. Read image-gen first. This model uses aspectRatio, with one output per call.',
      object({ prompt: string, image: { type: 'array', items: string }, aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16'] }, filename: string }, ['prompt'])],
    ['video_capabilities', 'Read current AI video capabilities before generating AI clips; local composition does not require this.', object({})],
    ['video_generate', 'Generate one paid AI clip after approval; resume an interrupted clip with its jobId. Read video-gen first.',
      object({ prompt: object({ style: string, scene: string, visuals: string, action: string }, ['visuals', 'action']), durationSec: { type: 'number' }, jobId: string })],
    ['video_render', 'Render a prepared multi-shot spec after approval. Read video-gen first.', object({ renderSpecPath: string }, ['renderSpecPath'])],
    ['video_compose', 'Locally compose existing clips or a timeline. Read video-gen first.', object({ composeSpecPath: string }, ['composeSpecPath'])],
  ];
  for (const [name, description, parameters] of definitions) {
    pi.registerTool({
      name, label: name, description, parameters,
      async execute(_id, args) {
        if (name === 'video_capabilities') return text({
          model: 'eval-video', provider: 'eval', account: 'eval', durationRange: [5, 10],
          nativeAudio: false, supportsFirstLastFrame: false, aspectRatios: ['16:9'], referenceAssetModalities: [],
        });
        if (name === 'video_generate' && process.env.SKILL_EVAL_SCENARIO === 'resume' && args.jobId !== 'existing-job') {
          return { ...text('Use the existing jobId to avoid duplicate billing'), isError: true };
        }
        return text({ status: 'completed', jobId: args.jobId ?? 'eval-job', path: name === 'image_generate' ? '/eval/result.png' : '/eval/final_video.mp4' });
      },
    });
  }
}
