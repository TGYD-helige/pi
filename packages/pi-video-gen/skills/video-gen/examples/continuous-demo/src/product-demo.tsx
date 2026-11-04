import React, { useState } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { RequestWorkspace, type RequestState } from '../product/RequestWorkspace';
import { stateAtTime, updates } from '../product/fixture.mjs';

const stage: React.CSSProperties = {
  background: '#eaf0fb', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

export function ProductDemo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <AbsoluteFill style={stage}><RequestWorkspace {...stateAtTime(frame / fps)} /></AbsoluteFill>;
}

export function ProductPlayground() {
  const [state, setState] = useState<RequestState>({ request: '', status: 'draft', updates: [] });
  return <AbsoluteFill style={stage}><RequestWorkspace {...state}
    onChange={(request) => setState({ request, status: 'draft', updates: [] })}
    onSubmit={() => setState({ ...state, status: 'done', updates: [...updates] })} />
  </AbsoluteFill>;
}
