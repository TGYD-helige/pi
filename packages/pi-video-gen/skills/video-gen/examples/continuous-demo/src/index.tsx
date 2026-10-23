import React from 'react';
import { AbsoluteFill, Audio, Composition, Easing, interpolate, registerRoot, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { durationSec, events, poses } from '../timing.mjs';

const blue = '#275de9';
const ink = '#12203c';
const ease = Easing.bezier(0.65, 0, 0.2, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const move = (t: number, from: number, to: number) => interpolate(t, [from, to], [0, 1], { ...clamp, easing: ease });
const visible = (t: number, start: number, end: number) => move(t, start, start + 0.45) * (1 - move(t, end - 0.4, end));

// Procedural footage: original geometry, deterministic at every frame, no remote assets.
const Artwork = ({ t, variant = 0, labelOpacity = 1 }: { t: number; variant?: number; labelOpacity?: number }) => {
  const palettes = [
    ['#061d4b', '#2264ef', '#83d9f7'],
    ['#3c1646', '#ed7a66', '#fbd6ac'],
    ['#0e4348', '#31b9a5', '#a5ead7'],
  ];
  const [dark, middle, light] = palettes[variant % 3]!;
  return <AbsoluteFill style={{ overflow: 'hidden', background: dark }}>
    <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%' }}>
      <defs>
        <radialGradient id={`orb-${variant}`} cx="36%" cy="26%" r="76%">
          <stop offset="0" stopColor={light} /><stop offset="0.42" stopColor={middle} /><stop offset="1" stopColor={dark} />
        </radialGradient>
        <linearGradient id={`ground-${variant}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor={middle} stopOpacity="0" /><stop offset="1" stopColor={middle} stopOpacity="0.5" />
        </linearGradient>
      </defs>
      <path d="M0 400 Q500 260 1000 410 L1000 600 L0 600Z" fill={`url(#ground-${variant})`} />
      {Array.from({ length: 17 }, (_, i) => <path key={i} d={`M-100 ${420 + i * 18} Q500 ${270 + i * 20} 1100 ${430 + i * 18}`} fill="none" stroke={light} opacity={0.05 + i * 0.003} strokeWidth="1" />)}
      {variant === 0 && <g transform={`translate(${620 + Math.sin(t * 0.65 + variant) * 28} ${270 + Math.cos(t * 0.6) * 12}) rotate(${-22 + t * 4 + variant * 18})`}>
        <circle r="167" fill={`url(#orb-${variant})`} />
        {Array.from({ length: 19 }, (_, i) => <ellipse key={i} rx={30 + i * 7.5} ry="168" transform={`rotate(${i * 9.5 + Math.sin(t * 0.4) * 14})`} fill="none" stroke={light} strokeWidth={i % 4 === 0 ? 1.6 : 0.8} opacity="0.23" />)}
        <ellipse rx="236" ry="53" fill="none" stroke={light} strokeWidth="9" transform={`rotate(${18 + Math.sin(t * 0.5) * 12})`} opacity="0.9" />
        <ellipse rx="252" ry="68" fill="none" stroke={light} strokeWidth="1" opacity="0.28" />
        <circle cx="-232" cy="-20" r="11" fill={light} />
      </g>}
      {variant === 1 && <g transform="translate(500 280) rotate(-18)">
        {Array.from({ length: 44 }, (_, i) => {
          const phase = i / 43 * Math.PI * 2 + t * 0.35;
          const x = Math.sin(phase) * 160;
          const y = Math.cos(phase) * 150;
          return <path key={i} d={`M-390 ${y * 0.4} C-240 ${y - 220} ${x - 150} ${-y} ${x} ${y} S300 ${y + 210} 390 ${-y * 0.4}`} fill="none" stroke={light} strokeWidth={i % 5 === 0 ? 4 : 1.3} opacity={0.3 + Math.sin(i / 44 * Math.PI) * 0.55} />;
        })}
      </g>}
      {variant === 2 && <g transform="translate(500 110)">
        {Array.from({ length: 25 }, (_, i) => {
          const col = i % 5, row = Math.floor(i / 5);
          const x = (col - row) * 58, y = (col + row) * 27;
          const h = 35 + (1 + Math.sin(col * 0.8 + row * 0.7 + t * 0.7)) * 75;
          return <g key={i} transform={`translate(${x} ${y})`}>
            <path d={`M0 ${-h} L54 ${27-h} L0 ${54-h} L-54 ${27-h}Z`} fill={light} />
            <path d={`M-54 ${27-h}L0 ${54-h}L0 54L-54 27Z`} fill={middle} />
            <path d={`M0 ${54-h}L54 ${27-h}L54 27L0 54Z`} fill="#258a89" />
          </g>;
        })}
      </g>}
      {Array.from({ length: 18 }, (_, i) => <circle key={i} cx={(i * 151 + t * (3 + i % 4)) % 1050} cy={60 + (i * 79) % 440} r={i % 3 === 0 ? 2.4 : 1.2} fill={light} opacity="0.4" />)}
    </svg>
    <div style={{ position: 'absolute', left: '6%', bottom: '8%', color: '#fff', fontSize: 23, letterSpacing: 4, opacity: 0.8 * labelOpacity }}>PI / MOTION MATERIAL {String(variant + 1).padStart(2, '0')}</div>
  </AbsoluteFill>;
};

const Heading = ({ t, start, end, label, children }: { t: number; start: number; end: number; label: string; children: React.ReactNode }) => {
  const opacity = visible(t, start, end);
  return <div style={{ position: 'absolute', left: 112, top: 266, opacity, transform: `translateY(${(1 - move(t, start, start + 0.7)) * 42}px)`, width: 610 }}>
    <div style={{ fontFamily: 'monospace', fontSize: 24, letterSpacing: 3, color: blue, marginBottom: 34 }}>{label}</div>
    <div style={{ fontSize: 82, fontWeight: 650, letterSpacing: -4, lineHeight: 1.23, whiteSpace: 'pre-line' }}>{children}</div>
  </div>;
};

const Timeline = ({ t }: { t: number }) => {
  const show = visible(t, 10.3, 14.2);
  const reveal = move(t, 10.3, events.edit);
  const play = move(t, events.edit, 17.4);
  return <div style={{ position: 'absolute', left: 112, right: 112, top: 770, height: 220, background: '#fff', border: '1px solid #dce4f1', borderRadius: 20, opacity: show, transform: `translateY(${(1 - reveal) * 110}px)`, overflow: 'hidden', boxShadow: '0 20px 70px #13316312' }}>
    <div style={{ position: 'absolute', left: 132, right: 25, top: 20, display: 'flex', justifyContent: 'space-between', font: '19px monospace', color: '#7e8aa0' }}>{['00:00', '00:04', '00:08', '00:12', '00:16', '00:20'].map((s) => <span key={s}>{s}</span>)}</div>
    {['画面', '声音', '字幕'].map((label, row) => <div key={label} style={{ position: 'absolute', left: 22, top: 61 + row * 48, fontSize: 22, color: '#62708a' }}>{label}</div>)}
    <div style={{ position: 'absolute', left: 128, top: 52, right: 24, height: 46, display: 'flex', gap: 7 }}>
      {['想法', '素材展开', '进入镜头', '多轨编排', '审阅交付'].map((label, i) => <div key={label} style={{ flex: i === 1 ? 1.5 : 1, background: i === 2 ? blue : '#e6edfc', borderRadius: 7, padding: '10px 18px', fontSize: 21, color: i === 2 ? '#fff' : '#3b5b96' }}>{label}</div>)}
    </div>
    <svg viewBox="0 0 1500 42" style={{ position: 'absolute', left: 128, right: 24, top: 108, width: 1535, height: 40 }}>
      {Array.from({ length: 140 }, (_, i) => { const a = 4 + Math.abs(Math.sin(i * 0.83) * Math.cos(i * 0.17)) * 32; return <rect key={i} x={i * 10.6} y={(42 - a) / 2} width="5" height={a} rx="2" fill="#4ba5b0" />; })}
    </svg>
    <div style={{ position: 'absolute', left: 128, right: 24, top: 160, height: 30, borderRadius: 6, background: '#f2d8bd', opacity: 0.8 }} />
    <div style={{ position: 'absolute', top: 42, bottom: 12, left: 128 + play * 1510, width: 3, background: '#e78553', boxShadow: '0 0 16px #e7855355' }}><div style={{ width: 12, height: 12, background: '#e78553', marginLeft: -4.5, borderRadius: 3 }} /></div>
  </div>;
};

const Review = ({ t }: { t: number }) => {
  const opacity = visible(t, 18, 22);
  return <div style={{ opacity }}>
    <div style={{ position: 'absolute', left: 116, top: 592, color: '#62708a', fontSize: 27, lineHeight: 2.1 }}>
      {['成片哈希与产物校验', '关键转场前、中、后抽帧', '源码和素材一起交付'].map((text, i) => <div key={text} style={{ opacity: move(t, 18.6 + i * 0.3, 19 + i * 0.3), transform: `translateX(${(1 - move(t, 18.6 + i * 0.3, 19 + i * 0.3)) * 22}px)` }}><span style={{ color: blue, marginRight: 20 }}>✓</span>{text}</div>)}
    </div>
    <div style={{ position: 'absolute', left: 794, right: 180, top: 730, display: 'flex', gap: 16 }}>
      {['转场前', '转场中', '转场后'].map((label, i) => <div key={label} style={{ flex: 1, opacity: move(t, 18.4 + i * 0.14, 18.9 + i * 0.14) }}>
        <div style={{ position: 'relative', height: 146, borderRadius: 12, overflow: 'hidden', border: i === 1 ? `3px solid ${blue}` : '3px solid #fff' }}><Artwork t={6.7 + i * 0.3} variant={0} labelOpacity={0} /></div>
        <div style={{ paddingTop: 14, textAlign: 'center', fontSize: 22, color: '#62708a' }}>{label}</div>
      </div>)}
    </div>
  </div>;
};

const Demo = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const pose = Object.fromEntries(['x', 'y', 'w', 'h', 'rx', 'ry', 'rz'].map((key) => [key, interpolate(t, poses.map((p) => p.at), poses.map((p) => p[key]), { ...clamp, easing: ease })]));
  const fan = visible(t, 2.9, 6.9);
  const full = move(t, 6.2, events.enter) * (1 - move(t, 9.5, events.edit));
  const layers = visible(t, 13.8, 18);
  const close = move(t, 21.2, events.resolve);
  const radius = (1 - full) * (26 + close * 15);
  const light = '#f1f4fa';
  return <AbsoluteFill style={{ background: light, color: ink, fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(#c8d2e4 1px, transparent 1px)', backgroundSize: '32px 32px', opacity: 0.27 }} />
    <div style={{ position: 'absolute', left: 112, right: 112, top: 62, display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: 24, letterSpacing: 2, color: '#6c7c96', opacity: 1 - full }}><span>PI / VIDEO GEN</span><span>LOCAL MOTION FILM · 026</span></div>
    <Heading t={t} start={-0.4} end={3.2} label="IDEA → MOTION">{'把想法，\n变成镜头。'}</Heading>
    <div style={{ position: 'absolute', left: 116, top: 560, opacity: visible(t, 0.3, 3.1), color: '#62708a', fontSize: 31, lineHeight: 1.8 }}>素材、生成、剪辑、审阅。<br />在同一个创作流程里完成。</div>
    <div style={{ position: 'absolute', left: 0, top: 125, width: '100%', textAlign: 'center', opacity: visible(t, 3, 6.7) }}><span style={{ fontSize: 76, fontWeight: 650, letterSpacing: -3 }}>把素材，编成故事。</span></div>
    <Heading t={t} start={10.2} end={14.1} label="ONE TIMELINE">{'画面、声音，\n在同一条线上。'}</Heading>
    <Heading t={t} start={14} end={17.9} label="PICTURE × SOUND">{'每个落点，\n都有回响。'}</Heading>
    <Heading t={t} start={18} end={22} label="REVIEW → DELIVER">{'交付之前，\n看清每一帧。'}</Heading>
    <div style={{ position: 'absolute', left: 116, top: 590, color: '#62708a', fontSize: 29, lineHeight: 1.8, opacity: layers }}>画面、文字和声音分层编排。<br />同一事件时间，驱动不同轨道。</div>
    <div style={{ position: 'absolute', inset: 0, perspective: 1800 }}>
      {[-1, 1].map((side, i) => <div key={side} style={{ position: 'absolute', left: 960 + side * (600 + (1 - move(t, 2.9, 4.2)) * 300) - 260, top: 390 + i * 46, width: 520, height: 340, borderRadius: 24, overflow: 'hidden', opacity: fan, transform: `rotateY(${-side * 24}deg) rotateZ(${side * 9}deg)`, boxShadow: '0 30px 70px #16366b24' }}><Artwork t={t + i} variant={i + 1} /></div>)}
      {[2, 1].map((i) => <div key={i} style={{ position: 'absolute', left: pose.x - pose.w / 2, top: pose.y - pose.h / 2 + 94 * i, width: pose.w, height: pose.h, background: i === 1 ? '#e3edff' : '#b5dce1', border: `2px solid ${i === 1 ? '#98b4f0' : '#72b6bf'}`, borderRadius: 26, opacity: layers * 0.92, transform: `rotateX(${pose.rx}deg) rotateY(${pose.ry}deg) rotateZ(${pose.rz}deg)`, boxShadow: '0 24px 50px #14356f15' }}>
        <div style={{ position: 'absolute', bottom: 16, left: 26, fontSize: 23, color: '#3d5e90' }}>{i === 1 ? 'TEXT / 文字层' : 'AUDIO / 声音层'}</div>
        {i === 2 && <svg viewBox="0 0 900 200" style={{ width: '100%', height: '50%', position: 'absolute', bottom: 24 }}>{Array.from({ length: 75 }, (_, j) => { const h = 14 + Math.abs(Math.sin(j * 0.8 + t * 3)) * 100; return <rect key={j} x={j * 12} y={100 - h / 2} width="6" height={h} rx="3" fill="#5999a5" opacity="0.7" />; })}</svg>}
      </div>)}
      <div style={{ position: 'absolute', left: pose.x - pose.w / 2, top: pose.y - pose.h / 2, width: pose.w, height: pose.h, borderRadius: radius, overflow: 'hidden', background: blue, transform: `rotateX(${pose.rx}deg) rotateY(${pose.ry}deg) rotateZ(${pose.rz}deg)`, boxShadow: full > 0.99 ? 'none' : '0 38px 100px #102a5d30' }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - close }}><Artwork t={t} labelOpacity={1 - move(t, 6.15, 6.45) * (1 - move(t, 10.7, 11))} /></div>
        <div style={{ position: 'absolute', left: 108, top: 330, color: '#fff', fontSize: 100, fontWeight: 650, letterSpacing: -5, lineHeight: 1.2, opacity: full }}>{'让每一镜'}<br />{'有下一镜。'}</div>
        <div style={{ position: 'absolute', left: 112, bottom: 95, color: '#a5cdfd', font: '22px monospace', letterSpacing: 3, opacity: visible(t, 7.3, 9.7) }}>ONE OBJECT. ONE CONTINUOUS WORLD.</div>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: close }}><svg viewBox="0 0 100 100" width="82" height="82"><path d="M36 20L78 50L36 80Z" fill="#fff" /></svg></div>
      </div>
    </div>
    <Timeline t={t} />
    <Review t={t} />
    <div style={{ position: 'absolute', left: 0, top: 520, width: '100%', textAlign: 'center', opacity: move(t, 22.2, 23.2), transform: `translateY(${(1 - move(t, 22.2, 23.2)) * 32}px)` }}>
      <div style={{ fontSize: 88, fontWeight: 650, letterSpacing: -4 }}>从想法，到成片。</div>
      <div style={{ fontFamily: 'monospace', fontSize: 37, color: blue, marginTop: 30 }}>pi-video-gen</div>
      <div style={{ fontSize: 28, color: '#6c7c96', marginTop: 55, letterSpacing: 5 }}>生成 · 编排 · 审阅 · 交付</div>
    </div>
    <Audio src={staticFile('score.wav')} volume={1} />
  </AbsoluteFill>;
};

registerRoot(() => <Composition id="ContinuousDemo" component={Demo} width={1920} height={1080} fps={30} durationInFrames={durationSec * 30} />);
