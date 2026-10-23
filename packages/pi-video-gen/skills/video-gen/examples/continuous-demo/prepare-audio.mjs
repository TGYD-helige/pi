import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { durationSec, events, poses } from './timing.mjs';

assert(poses[0].at === 0 && poses.at(-1).at === durationSec);
assert(poses.every((p, i) => Object.values(p).every(Number.isFinite) && p.w > 0 && p.h > 0 && (!i || p.at > poses[i - 1].at)));
assert(Object.values(events).every((t) => t > 0 && t < durationSec));
const rate = 48000;
const count = Math.round(rate * durationSec);
const samples = new Float32Array(count * 2);
const roots = [73.416, 65.406, 87.307, 98];
const scale = [0, 7, 12, 16, 19, 12, 7, 16];
const hits = Object.values(events);
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
  const duck = hits.reduce((v, hit) => v * (1 - 0.55 * Math.exp(-(((t - hit) / 0.22) ** 2))), 1);
  const bass = Math.sin(2 * Math.PI * root * t) * Math.exp(-beat * 6) * 0.09;
  const pluck = (Math.sin(2 * Math.PI * f * nt) + 0.25 * Math.sin(2 * Math.PI * f * 2.01 * nt)) * Math.exp(-nt * 15) * Math.min(1, nt * 500) * 0.055;
  const pad = (Math.sin(2 * Math.PI * root * 2 * t) + Math.sin(2 * Math.PI * root * 2.5 * t)) * 0.023;
  const kick = Math.sin(2 * Math.PI * (45 * beat - 4 * Math.exp(-beat * 28))) * Math.exp(-beat * 22) * 0.11;
  const hat = noise * Math.exp(-(t % 0.15) * 140) * 0.013;
  let accent = 0;
  for (const at of hits) {
    const d = t - at;
    if (d > -0.4 && d < 0) accent += noise * (1 + d / 0.4) ** 2 * 0.045;
    if (d >= 0 && d < 0.75) {
      accent += Math.sin(2 * Math.PI * (54 * d + 4 * (1 - Math.exp(-d * 15)))) * Math.exp(-d * 10) * 0.18;
      accent += (Math.sin(2 * Math.PI * 880 * d) + 0.28 * Math.sin(2 * Math.PI * 2216 * d)) * Math.exp(-d * 12) * Math.min(1, d * 600) * 0.06;
    }
  }
  const music = ((bass + pluck + pad) * pause * duck + kick * pause + hat * pause) * fade;
  const left = music + accent * fade;
  const right = music + Math.sin(t * 1.9) * pad * 0.3 * fade + accent * fade;
  assert(Number.isFinite(left) && Number.isFinite(right));
  samples[i * 2] = left;
  samples[i * 2 + 1] = right;
  peak = Math.max(peak, Math.abs(left), Math.abs(right));
}
assert(peak > 0.05 && peak < 2);
const gain = 0.65 / peak;
const wav = Buffer.alloc(44 + count * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(count * 4, 40);
for (let i = 0; i < samples.length; i++) {
  const value = Math.round(samples[i] * gain * 32767);
  assert(Math.abs(value) <= 32767);
  wav.writeInt16LE(value, 44 + i * 2);
}
assert(Math.abs(samples[0]) < 1e-6 && Math.abs(samples.at(-1)) < 0.001);
mkdirSync(new URL('./public/', import.meta.url), { recursive: true });
writeFileSync(new URL('./public/score.wav', import.meta.url), wav);
console.error(`[continuous-demo] Created ${durationSec}s original stereo score; peak target -3.7 dBFS.`);
