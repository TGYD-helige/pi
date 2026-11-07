#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const version = argument('version');
const channel = argument('channel');
const output = argument('output');
if (!version || !channel || !output) {
  throw new Error('Usage: generate-release-summary.mjs --version <version> --channel <tag> --output <file>');
}
if (channel !== 'beta' && channel !== 'latest') {
  throw new Error(`Unsupported release channel: ${channel}`);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lines(value) {
  return value ? value.split('\n').filter(Boolean) : [];
}

function stripCodeFence(value) {
  return value
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function stripGeneratedChangelog(value) {
  return value.replace(/\n*\*\*Full Changelog\*\*:.*$/m, '').trim();
}

const currentTag = `v${version}`;
let previousTag;
try {
  const describeArgs = [
    'describe',
    '--tags',
    '--exclude',
    currentTag,
    '--abbrev=0',
  ];
  if (channel === 'beta') {
    describeArgs.push('--match', 'v*-beta.*');
  } else {
    describeArgs.push('--match', 'v[0-9]*', '--exclude', 'v*-*');
  }
  previousTag = git([...describeArgs, 'HEAD']);
} catch {
  previousTag = undefined;
}
const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
const commits = lines(git(['log', range, '--pretty=format:%h\t%s']));
const changedFiles = lines(git(['diff', '--name-status', ...(previousTag ? [previousTag, 'HEAD'] : ['HEAD'])]));
const publishedPackages = lines((process.env.PUBLISHED_PACKAGES || '').replace(/\s+/g, '\n'));

function localFallback() {
  const listed = commits.slice(0, 80).map((entry) => {
    const [sha, ...subject] = entry.split('\t');
    return `- ${subject.join('\t')} (${sha})`;
  });
  if (commits.length > listed.length) listed.push(`- …and ${commits.length - listed.length} more commits`);
  return ['## Changes', '', ...(listed.length ? listed : ['- Initial release']), ''].join('\n');
}

async function githubNotes() {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return undefined;

  const response = await fetch(
    `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/releases/generate-notes`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        tag_name: currentTag,
        target_commitish: process.env.GITHUB_SHA || 'HEAD',
        ...(previousTag ? { previous_tag_name: previousTag } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub generate-notes returned ${response.status}`);
  const data = await response.json();
  return typeof data.body === 'string' && data.body.trim()
    ? stripGeneratedChangelog(data.body)
    : undefined;
}

async function modelSummary(sourceNotes) {
  const baseUrl = (process.env.PI_INTEGRATION_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.PI_INTEGRATION_API_KEY || '';
  if (!baseUrl || !apiKey) {
    console.error('::warning::PI_INTEGRATION_BASE_URL / PI_INTEGRATION_API_KEY not set — using fallback release notes');
    return undefined;
  }

  const prompt = await readFile(new URL('../release-summary-prompt.md', import.meta.url), 'utf8');
  const releaseData = {
    version: currentTag,
    previousVersion: previousTag || null,
    npmDistTag: channel,
    publishedPackages,
    generatedNotes: sourceNotes,
    changedFiles: changedFiles.slice(0, 300),
    commits: commits.slice(0, 200),
    commitCount: commits.length,
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      temperature: 0.2,
      max_tokens: 1_400,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(releaseData) },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`release summary gateway returned ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    console.error('::warning::release summary model returned empty content — using fallback release notes');
    return undefined;
  }
  return stripCodeFence(content);
}

let generatedNotes;
try {
  generatedNotes = await githubNotes();
} catch (error) {
  console.error(`::warning::${error instanceof Error ? error.message : 'GitHub release notes unavailable'}`);
}

const fallback = generatedNotes || localFallback();
let summary;
try {
  summary = await modelSummary(fallback.slice(0, 60_000));
} catch (error) {
  console.error(`::warning::${error instanceof Error ? error.message : 'Release summary model unavailable'}`);
}

const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
const repository = process.env.GITHUB_REPOSITORY;
const changelogUrl = repository
  ? previousTag
    ? `${serverUrl}/${repository}/compare/${previousTag}...${currentTag}`
    : `${serverUrl}/${repository}/commits/${currentTag}`
  : undefined;
const metadata = [
  '## Release details',
  '',
  `- Version: \`${currentTag}\``,
  `- npm dist-tag: \`${channel}\``,
  `- Compared with: ${previousTag ? `\`${previousTag}\`` : 'initial release'}`,
  ...(changelogUrl ? ['', `[Full changelog](${changelogUrl})`] : []),
  '',
].join('\n');

// The model narrative and GitHub's generated PR list complement each other —
// keep both when the summary succeeds so releases don't flip between formats.
const body = [...(summary ? [summary, generatedNotes] : [fallback]), metadata]
  .filter(Boolean)
  .join('\n\n');
await writeFile(output, body, 'utf8');
console.error(
  `Release notes written to ${output} (${previousTag || 'initial release'} -> ${currentTag}, ${summary ? `model summary${generatedNotes ? ' + GitHub notes' : ''}` : 'fallback'})`,
);
