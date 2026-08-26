import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatBridge } from '../dist/bridge.js';

const root = await mkdtemp(join(tmpdir(), 'pi-channels-image-bridge-'));
const fakePi = join(root, 'fake-pi');
const argsFile = join(root, 'args.txt');
const workspace = join(root, 'workspace');
const attachmentDir = await mkdtemp(join(tmpdir(), 'pi-channels-feishu-image-'));
const imagePath = join(attachmentDir, 'image');
await mkdir(workspace);
await writeFile(
  fakePi,
  '#!/bin/sh\nprintf "%s\\n" "$@" > "$PI_CHANNELS_PROBE_ARGS"\nprintf "pong\\n"\n',
);
await chmod(fakePi, 0o755);
await writeFile(argsFile, '');
await writeFile(imagePath, 'fake-png');
process.env.PI_CHANNELS_PROBE_ARGS = argsFile;

const sent = [];
const registry = {
  getAdapter: () => undefined,
  send: async (message) => {
    sent.push(message);
  },
};
const bridge = new ChatBridge(
  { enabled: true, piBin: fakePi, persistSessions: false },
  workspace,
  registry,
);
bridge.start();
await bridge.handleMessage({
  adapter: 'feishu',
  sender: 'oc_chat',
  text: '请看图',
  attachments: [{ type: 'image', path: imagePath, mimeType: 'image/png' }],
  metadata: { messageId: 'om_image_1' },
});

for (let i = 0; i < 100 && sent.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

console.log(JSON.stringify({
  sent,
  cliArgs: (await readFile(argsFile, 'utf8')).trim().split('\n'),
  attachmentDirExistsAfterPrompt: existsSync(attachmentDir),
}, null, 2));

bridge.stop();
delete process.env.PI_CHANNELS_PROBE_ARGS;
await rm(root, { recursive: true, force: true });
await rm(attachmentDir, { recursive: true, force: true });
