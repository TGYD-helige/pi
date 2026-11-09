import { Socket } from 'node:net';

// Performance workers only measure local engineering paths; service tests belong in Integration.
export const OFFLINE_MESSAGE = 'Performance workers must not make network requests';
Socket.prototype.connect = function () {
  throw new Error(OFFLINE_MESSAGE);
};
globalThis.fetch = async () => {
  throw new Error(OFFLINE_MESSAGE);
};
