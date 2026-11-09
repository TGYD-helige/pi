import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { BROWSER_TASKS } from './tasks.js';

export async function startBrowserFixture() {
  const nonce = randomBytes(6).toString('hex');
  const username = `user-${nonce}`;
  const password = `pass-${nonce}`;
  const original = `Original-${nonce}`;
  const replacement = `Saved-${nonce}`;
  let saved = original;
  let loggedIn = false;
  let cancelled = false;
  let lastPage = '';
  const visited = new Set<string>();
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'POST' && ['/login', '/save', '/cancel'].includes(pathname)) {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) {
            res.writeHead(413).end();
            return;
          }
        }
        const params = new URLSearchParams(body);
        if (pathname === '/login') {
          if (params.get('username') !== username || params.get('password') !== password) {
            res.writeHead(403).end('Invalid login');
            return;
          }
          loggedIn = true;
        } else {
          if (params.get('note') !== replacement) {
            res.writeHead(400).end('Invalid note');
            return;
          }
          if (pathname === '/cancel') cancelled = true;
          else saved = replacement;
        }
        res.writeHead(303, { Location: pathname === '/login' ? '/secure' : '/saved' }).end();
        return;
      }
      const pages: Record<string, string> = {
        '/': `<h1>Example Domain ${nonce}</h1><a href="/article">Learn more ${nonce}</a><a href="/ab">A/B Testing</a>`,
        '/alternate': `<h1>Second Domain ${nonce}</h1>`,
        '/article':
          '<h1>Web browser</h1><p>A web browser is an application for accessing websites.</p>',
        '/ab': `<h1>A/B Test ${nonce}</h1>`,
        '/login':
          '<h1>Login</h1><form method="post" action="/login"><label>Username<input name="username"></label><label>Password<input type="password" name="password"></label><button>Login</button></form>',
        '/editor': `<h1>Note editor</h1><form method="post" action="/save"><label>Note<input name="note" value="${saved}"></label><button>Save</button><button formaction="/cancel">Cancel</button></form>`,
        '/saved': `<h1>Saved note</h1><p>${saved}</p>`,
      };
      if (loggedIn) pages['/secure'] = `<h1>Secure Area ${nonce}</h1>`;
      const page = pages[pathname];
      if (req.method !== 'GET' || !page) {
        res.writeHead(404).end('Not found');
        return;
      }
      lastPage = pathname;
      visited.add(pathname);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`<!doctype html><html lang="en"><title>Pi eval</title><body>${page}</body></html>`);
    } catch {
      res.writeHead(400).end('Invalid request');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  const url = `http://127.0.0.1:${address.port}`;
  const tasks = BROWSER_TASKS.map((task) => {
    const expected =
      task.id === 'form-save'
        ? replacement
        : task.id === 'form-cancel'
          ? original
          : task.id === 'article-first-sentence'
            ? task.gold
            : `${task.gold} ${nonce}`;
    const destination =
      task.id === 'multi-step-navigate'
        ? '/ab'
        : task.id === 'login-form-submit'
          ? '/secure'
          : task.id.startsWith('form-')
            ? '/saved'
            : task.startUrl;
    return {
      ...task,
      startUrl: url + task.startUrl,
      gold: expected,
      instruction:
        task.instruction +
        (task.id === 'login-form-submit'
          ? ` Username: ${username}. Password: ${password}.`
          : task.id.startsWith('form-')
            ? ` New value: ${replacement}.`
            : ''),
      check: ({ answer }: { answer: string; observed: string }) =>
        answer.toLowerCase().includes(expected.toLowerCase()) &&
        visited.has(destination) &&
        (task.id !== 'login-form-submit' || loggedIn) &&
        (task.id !== 'form-save' || saved === replacement) &&
        (task.id !== 'form-cancel' || (cancelled && saved === original)),
    };
  });
  return {
    url,
    username,
    password,
    tasks,
    state: () => ({ lastPage, visited: [...visited], loggedIn, saved, cancelled }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
