import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { durationSec, events, poses } from './timing.mjs';

assert(poses[0].at === 0 && poses.at(-1).at === durationSec);
assert(poses.every((p, i) => Object.values(p).every(Number.isFinite) && p.w > 0 && p.h > 0 && (!i || p.at > poses[i - 1].at)));
assert(Object.values(events).every((t) => t > 0 && t < durationSec));
const rate = 48000;
const count = Math.round(rate * durationSec);
const musicSamples = new Float32Array(count * 2);
const effectSamples = new Float32Array(count * 2);
const roots = [73.416, 65.406, 87.307, 98];
const scale = [0, 7, 12, 16, 19, 12, 7, 16];
const hits = Object.values(events);
// Calibrate this synthesized cue's sample peak; the lead-in stays before its landing.
const leadFrames = Math.round(0.4 * rate);
const cue = new Float32Array(leadFrames + Math.round(0.75 * rate));
let cuePeakFrame = leadFrames;
let cueSeed = 317;
for (let i = 0; i < cue.length; i++) {
  const d = (i - leadFrames) / rate;
  cueSeed = (Math.imul(cueSeed, 1664525) + 1013904223) >>> 0;
  if (d < 0) cue[i] = (cueSeed / 4294967296 * 2 - 1) * (1 + d / 0.4) ** 2 * 0.045;
  else {
    cue[i] = Math.sin(2 * Math.PI * (54 * d + 4 * (1 - Math.exp(-d * 15)))) * Math.exp(-d * 10) * 0.18
      + (Math.sin(2 * Math.PI * 880 * d) + 0.28 * Math.sin(2 * Math.PI * 2216 * d)) * Math.exp(-d * 12) * Math.min(1, d * 600) * 0.06;
  }
  if (Math.abs(cue[i]) > Math.abs(cue[cuePeakFrame])) cuePeakFrame = i;
}
const cueStarts = hits.map((at) => Math.round(at * rate) - cuePeakFrame);
let seed = 317;
let peak = 0;
for (let i = 0; i < count; i++) {
  const t = i / rate;
  const root = roots[Math.min(3, Math.floor(t / 6))];
  const beat = t % 0.6;
  const note = Math.floor(t / 0.3);
  const nt = t % 0.3;
  const f = root * 2 ** (scale[note % scale.length] / 12) * 2;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const noise = seed / 4294967296 * 2 - 1;
  const fade = Math.min(1, t / 0.35, (durationSec - t) / 1.8);
  const pause = t > 6.9 && t < 7.55 ? 0.15 : 1;
  const duck = Math.min(...hits.map((hit) => 1 - 0.55 * Math.exp(-(((t - hit) / 0.22) ** 2))));
  const bass = Math.sin(2 * Math.PI * root * t) * Math.exp(-beat * 6) * 0.09;
  const pluck = (Math.sin(2 * Math.PI * f * nt) + 0.25 * Math.sin(2 * Math.PI * f * 2.01 * nt)) * Math.exp(-nt * 15) * Math.min(1, nt * 500) * 0.055;
  const pad = (Math.sin(2 * Math.PI * root * 2 * t) + Math.sin(2 * Math.PI * root * 2.5 * t)) * 0.023;
  const kick = Math.sin(2 * Math.PI * (45 * beat - 4 * Math.exp(-beat * 28))) * Math.exp(-beat * 22) * 0.11;
  const hat = noise * Math.exp(-(t % 0.15) * 140) * 0.013;
  let accent = 0;
  for (const start of cueStarts) accent += cue[i - start] ?? 0;
  const music = (bass + pluck + pad + kick + hat) * pause * duck * fade;
  const leftMusic = music;
  const rightMusic = music + Math.sin(t * 1.9) * pad * 0.3 * fade * duck;
  const effect = accent * fade;
  const left = leftMusic + effect;
  const right = rightMusic + effect;
  assert(Number.isFinite(left) && Number.isFinite(right));
  musicSamples[i * 2] = leftMusic;
  musicSamples[i * 2 + 1] = rightMusic;
  effectSamples[i * 2] = effect;
  effectSamples[i * 2 + 1] = effect;
  peak = Math.max(peak, Math.abs(left), Math.abs(right), Math.abs(leftMusic), Math.abs(rightMusic), Math.abs(effect));
}
assert(peak > 0.05 && peak < 2);
const gain = 0.65 / peak;
mkdirSync(new URL('./public/', import.meta.url), { recursive: true });
const tracks = {};
for (const name of ['music', 'effects', 'score']) {
  const wav = Buffer.alloc(44 + count * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 4, 40);
  let trackPeak = 0;
  for (let i = 0; i < musicSamples.length; i++) {
    const sample = name === 'music' ? musicSamples[i] : name === 'effects' ? effectSamples[i] : musicSamples[i] + effectSamples[i];
    const value = Math.round(sample * gain * 32767);
    assert(Number.isFinite(sample) && Math.abs(value) <= 32767);
    wav.writeInt16LE(value, 44 + i * 2);
    trackPeak = Math.max(trackPeak, Math.abs(value) / 32767);
  }
  assert(wav.readInt16LE(44) === 0 && Math.abs(wav.readInt16LE(wav.length - 2)) < 33);
  writeFileSync(new URL(`./public/${name}.wav`, import.meta.url), wav);
  tracks[name] = { samplePeakDbfs: 20 * Math.log10(trackPeak), sha256: createHash('sha256').update(wav).digest('hex') };
}
writeFileSync(new URL('./public/audio-report.json', import.meta.url), JSON.stringify({
  sampleRate: rate, durationSec, gain, tracks, landmark: 'absolute-sample-peak',
  cues: Object.entries(events).map(([event, landingSec], i) => ({ event, landingSec, startSec: cueStarts[i] / rate, peakSec: (cueStarts[i] + cuePeakFrame) / rate })),
}, null, 2) + '\n');
console.error(`[continuous-demo] Created ${durationSec}s music, effects, reference mix and sample-peak report; not a listening or loudness pass.`);
