export const durationSec = 26;
export const events = { gather: 4.2, enter: 7.6, edit: 11, layers: 14.8, review: 18.5, resolve: 22.8 };
// One persistent preview travels through the whole film. Positions are composition pixels.
export const poses = [
  { at: 0, x: 1390, y: 565, w: 660, h: 550, rx: -8, ry: -24, rz: 8 },
  { at: 2.5, x: 1390, y: 565, w: 660, h: 550, rx: -8, ry: -24, rz: 8 },
  { at: events.gather, x: 960, y: 580, w: 1100, h: 620, rx: 0, ry: 0, rz: 0 },
  { at: 6.2, x: 960, y: 580, w: 1100, h: 620, rx: 0, ry: 0, rz: 0 },
  { at: events.enter, x: 960, y: 540, w: 1920, h: 1080, rx: 0, ry: 0, rz: 0 },
  { at: 9.5, x: 960, y: 540, w: 1920, h: 1080, rx: 0, ry: 0, rz: 0 },
  { at: events.edit, x: 1210, y: 410, w: 1020, h: 574, rx: 0, ry: 0, rz: 0 },
  { at: 13.6, x: 1210, y: 410, w: 1020, h: 574, rx: 0, ry: 0, rz: 0 },
  { at: events.layers, x: 1260, y: 410, w: 940, h: 530, rx: 34, ry: -14, rz: -8 },
  { at: 16.8, x: 1260, y: 410, w: 940, h: 530, rx: 34, ry: -14, rz: -8 },
  { at: events.review, x: 1260, y: 410, w: 960, h: 540, rx: 0, ry: 0, rz: 0 },
  { at: 21.2, x: 1260, y: 410, w: 960, h: 540, rx: 0, ry: 0, rz: 0 },
  { at: events.resolve, x: 960, y: 360, w: 146, h: 146, rx: 0, ry: 0, rz: 0 },
  { at: durationSec, x: 960, y: 360, w: 146, h: 146, rx: 0, ry: 0, rz: 0 },
];
