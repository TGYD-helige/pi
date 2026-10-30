import { rm } from 'node:fs/promises';
import type { BrowserUseConfig } from './config.js';
import { type SessionRecord, writeSessionRecord } from './session-client.js';
import { serveBrowserSession } from './session-server.js';

process.once(
  'message',
  async (message: { config: BrowserUseConfig; path: string; record: SessionRecord }) => {
    let server: Awaited<ReturnType<typeof serveBrowserSession>> | undefined;
    const shutdown = () => {
      if (server) void server.stop('lost').finally(() => process.exit());
      else process.exit(1);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    try {
      server = await serveBrowserSession(message.config, message.record.token, {
        ...(message.record.binding ? { browser: message.record.binding } : {}),
        async onAcquire(browser) {
          message.record.managed = browser;
          await writeSessionRecord(message.path, message.record);
        },
        async onStop(reason) {
          message.record.ended = reason;
          if (reason === 'closed') await rm(message.path, { force: true });
          else await writeSessionRecord(message.path, message.record);
        },
      });
      message.record.port = server.port;
      await writeSessionRecord(message.path, message.record);
      process.send?.({ ready: true });
    } catch {
      await writeSessionRecord(message.path, { ...message.record, ended: 'startup-failed' });
      process.send?.({ ready: false });
      process.exitCode = 1;
    }
  },
);
