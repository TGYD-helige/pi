#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  process.stdout.write(`Usage: node search-seedance-personas.mjs --query <terms> [options]\n\nOptions:\n  --framing any|half|full  Require an available framing (default: any)\n  --limit <1-50>           Maximum returned matches (default: 10)\n  --help                   Show this help\n`);
  process.exit(0);
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

try {
  const query = option('--query', '').trim();
  const framing = option('--framing', 'any');
  const limit = Number.parseInt(option('--limit', '10'), 10);

  if (!query) throw new Error('--query is required');
  if (!['any', 'half', 'full'].includes(framing)) {
    throw new Error('--framing must be any, half, or full');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('--limit must be an integer from 1 to 50');
  }

  const catalogPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'references',
    'seedance-personas.json',
  );
  const personas = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const terms = query.toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
  const matches = personas.filter((persona) => {
    const half = persona.assets['半身像'];
    const full = persona.assets['全身照'];
    if (framing === 'half' && !half) return false;
    if (framing === 'full' && !full) return false;
    const searchable = [persona.group_id, persona['人物标签'], persona['人物小传'], half, full]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('zh-CN');
    return terms.every((term) => searchable.includes(term));
  });

  const results = matches.slice(0, limit).map((persona) => {
    const half = persona.assets['半身像'];
    const full = persona.assets['全身照'];
    const selectedFraming = framing === 'full' || (!half && full) ? 'full' : 'half';
    return {
      groupId: persona.group_id,
      label: persona['人物标签'],
      bio: persona['人物小传'],
      assets: { half: half || null, full: full || null },
      selectedFraming,
      selectedAssetId: selectedFraming === 'full' ? full : half,
    };
  });

  process.stdout.write(
    `${JSON.stringify({ query, framing, totalMatches: matches.length, returned: results.length, results }, null, 2)}\n`,
  );
} catch (error) {
  console.error(`[pi-video-gen] ${error instanceof Error ? error.message : 'persona search failed'}`);
  process.exitCode = 1;
}
