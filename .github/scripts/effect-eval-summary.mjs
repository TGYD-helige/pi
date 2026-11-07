import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Usage: effect-eval-summary.mjs <results.json>');
if (!existsSync(file)) {
  process.stdout.write('no results\n');
  process.exit(0);
}
process.stdout.write('## Browser eval — task completion\n');
const d = JSON.parse(readFileSync(file, 'utf8'));
const s = d.summary || {};
console.log('');
console.log(`- model: \`${d.configuration?.model ?? s.model ?? '?'}\``);
console.log(
  `- successRate: **${(s.successRate ?? 0).toFixed(3)}** (${s.n ?? 0} trials, crashes included)`,
);
console.log(`- nonCrashSuccessRate: ${(s.nonCrashSuccessRate ?? 0).toFixed(3)}`);
console.log(`- consistentTaskRate: ${(s.consistentTaskRate ?? 0).toFixed(3)}`);
console.log(`- avgTurns (to success): ${(s.avgTurns ?? 0).toFixed(1)}`);
console.log(`- avgToolCalls: ${(s.avgToolCalls ?? 0).toFixed(1)}`);
console.log(`- failureMix: \`${JSON.stringify(s.failureMix ?? {})}\``);
console.log('');
console.log('| task | success | mode | turns | tools |');
console.log('|------|:-------:|------|------:|------:|');
for (const r of d.rows ?? []) {
  console.log(
    `| ${r.task} | ${r.success ? '✅' : '❌'} | ${r.failureMode} | ${r.turns} | ${r.toolCalls} |`,
  );
}
