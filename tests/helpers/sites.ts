import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CANARY = 'CANARY-pw-7Qz!x9 &Lm=4+/e2e';
export const CANARY_USER = 'alice@example.test';

export interface Received {
  host: string;
  path: string;
  fields: Record<string, string>;
}

/** Tiny fake login sites. Host header decides the "site": good.localhost / evil.localhost / cdn.localhost. */
export async function startSites(): Promise<{
  port: number;
  url: (host: string, path: string) => string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const page = (title: string, body: string, script = '') =>
    `<!doctype html><html><head><meta charset=utf-8><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

  const loginForm = (extra = '', action = '/login') => `
    <form method="post" action="${action}">
      ${extra}
      <label for="em">Email</label><input id="em" name="email" type="email" autocomplete="username">
      <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>`;

  const server: Server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const u = new URL(req.url ?? '/', 'http://x');
    const html = (s: string, code = 200) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(s);
    };
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const fields = Object.fromEntries(new URLSearchParams(raw));
        received.push({ host, path: u.pathname, fields });
        if (fields.password === CANARY) {
          res.writeHead(302, { location: '/home' });
          res.end();
        } else html(page('Sign in', '<div id="error">Invalid credentials</div>'), 401);
      });
      return;
    }
    const p = u.pathname;
    switch (p) {
      case '/simple':
        return html(page('Sign in', `<h1>Sign in</h1>${loginForm()}`));
      case '/home':
        return html(page('Home', '<h1 id="welcome">Welcome back</h1>'));
      case '/step1':
        return html(
          page(
            'Step 1',
            `<form method="get" action="/step2"><label>Email</label><input name="email" type="email" autocomplete="username"><button type="submit">Next</button></form>`,
          ),
        );
      case '/step2':
        return html(
          page(
            'Step 2',
            `<form method="post" action="/login"><input type="hidden" name="email" value="${u.searchParams.get('email') ?? ''}"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
          ),
        );
      case '/framed':
        return html(
          page(
            'Framed',
            `<h1>Portal</h1><iframe src="http://evil.localhost:${(server.address() as AddressInfo).port}/simple" width="400" height="300"></iframe>`,
          ),
        );
      case '/framed-bound':
        return html(
          page(
            'Framed bound',
            `<h1>Portal</h1><iframe src="http://cdn.localhost:${(server.address() as AddressInfo).port}/simple" width="400" height="300"></iframe>`,
          ),
        );
      case '/honeypot':
        return html(
          page(
            'Honeypot',
            `<form method="post" action="/login">
              <input name="username" style="display:none" tabindex="-1" autocomplete="off">
              <input name="website_email" type="text" style="position:absolute;left:-9999px" tabindex="-1">
              <input name="login_password" type="password" style="opacity:0;width:1px;height:1px" tabindex="-1" autocomplete="off">
              <label>Email</label><input name="email" type="email" autocomplete="username">
              <label>Password</label><input name="password" type="password" autocomplete="current-password">
              <button type="submit">Sign in</button></form>`,
          ),
        );
      case '/spa':
        return html(
          page(
            'SPA',
            '<div id="root"></div>',
            `const f = () => { document.getElementById('root').innerHTML = ${JSON.stringify(
              `<form method="post" action="/login"><label>Email</label><input name="email" type="email" autocomplete="username"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
            )}; };
             setTimeout(f, 400); setTimeout(f, 900);`,
          ),
        );
      case '/keys':
        return html(
          page(
            'Keys only',
            `<form method="post" action="/login"><label>Email</label><input id="e" name="email" type="email" autocomplete="username"><label>Password</label><input id="p" name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
            `for (const el of document.querySelectorAll('input')) { let model = ''; el.addEventListener('keydown', (e) => { if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) model += e.key; }); el.addEventListener('input', () => { el.value = model; }); }`,
          ),
        );
      case '/onlyhidden':
        return html(
          page(
            'Hidden',
            `<form method="post" action="/login"><input name="password" type="password" style="display:none"><button>go</button></form>`,
          ),
        );
      case '/ambiguous':
        return html(
          page(
            'Ambiguous',
            `<form method="post" action="/login"><input name="email" type="email"><input name="password" type="password" placeholder="Password"></form>
             <form method="post" action="/login"><input name="email" type="email"><input name="password" type="password" placeholder="Password"></form>`,
          ),
        );
      case '/echo':
        // a hostile page that reflects what was typed into the DOM (for the lock test)
        return html(page('Echo', loginForm()));
      default:
        return html(page('404', 'nope'), 404);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (host, path) => `http://${host}:${port}${path}`,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
