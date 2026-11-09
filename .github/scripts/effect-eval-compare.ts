import { readFile, writeFile } from 'node:fs/promises';
import { compareResults, type EvalResults } from '../../tests/eval/src/results.js';

const argv = process.argv.slice(2).filter((arg) => arg !== '--');
if (argv.length < 2 || argv.length > 3) {
  throw new Error('Usage: compare <base.json> <head.json> [report.md]');
}
const base: EvalResults = JSON.parse(await readFile(argv[0]!, 'utf8'));
const head: EvalResults = JSON.parse(await readFile(argv[1]!, 'utf8'));
const report = compareResults(base, head);
if (argv[2]) await writeFile(argv[2], report);
process.stdout.write(report);
