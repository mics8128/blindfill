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
        if (u.pathname === '/passkey') {
          res.writeHead(200).end(); // the test verifies the assertion itself
          return;
        }
        if (fields.password === CANARY || fields.a2 === CANARY) {
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
      case '/passkey':
        // relying party: asks for any discoverable passkey for this host, posts the assertion
        return html(
          page(
            'Passkey',
            '<h1>Sign in</h1><button id="pk" type="button">Sign in with a passkey</button>',
            `const b = (x) => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
            document.getElementById('pk').onclick = async () => {
              const challenge = crypto.getRandomValues(new Uint8Array(32));
              const c = await navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, userVerification: 'preferred' } });
              const r = c.response;
              const body = new URLSearchParams({ id: c.id, authenticatorData: b(r.authenticatorData),
                clientDataJSON: b(r.clientDataJSON), signature: b(r.signature), userHandle: r.userHandle ? b(r.userHandle) : '' });
              const res = await fetch('/passkey', { method: 'POST', body });
              location.href = res.ok ? '/home' : '/passkey?fail=1';
            };`,
          ),
        );
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
      case '/multi':
        return html(
          page(
            'Multi',
            `<form id="newsletter" method="post" action="/newsletter"><input name="email" type="email" placeholder="Email for news"><button type="submit">Subscribe</button></form>
             <form id="signin" method="post" action="/login"><input id="u" name="a1" type="text"><input id="p" name="a2" type="password"><button id="go" type="submit">Go</button></form>`,
          ),
        );
      case '/register':
        return html(
          page(
            'Create account',
            `<h1>Create account</h1><form id="signup" method="post" action="/register">
              <input id="login" name="login" type="text"><input id="display" name="display" type="text">
              <input id="pw1" name="password" type="password" autocomplete="new-password">
              <input id="pw2" name="confirm" type="password" autocomplete="new-password">
              <button id="create" type="submit">Create</button></form>`,
          ),
        );
      case '/register-xorigin':
        return html(
          page(
            'Create account',
            `<form id="signup" method="post" action="http://evil.localhost:${(server.address() as AddressInfo).port}/register">
              <input id="login" name="login" type="text"><input id="pw1" name="password" type="password"><input id="pw2" name="confirm" type="password">
              <button id="create" type="submit">Create</button></form>`,
          ),
        );
      case '/register-get':
        return html(
          page(
            'Create account',
            `<form id="signup" method="get" action="/register">
              <input id="login" name="login" type="text"><input id="pw1" name="password" type="password"><input id="pw2" name="confirm" type="password">
              <button id="create" type="submit">Create</button></form>`,
          ),
        );
      case '/register-extra-pw':
        return html(
          page(
            'Create account',
            `<form id="signup" method="post" action="/register">
              <input id="login" name="login" type="text"><input id="pw1" name="password" type="password"><input id="pw2" name="confirm" type="password"><input id="pw3" name="third" type="password">
              <button id="create" type="submit">Create</button></form>`,
          ),
        );
      case '/register-nocopy':
        // the page rewrites the confirmation field after input: values will not match
        return html(
          page(
            'Create account',
            `<form id="signup" method="post" action="/register">
              <input id="login" name="login" type="text"><input id="pw1" name="password" type="password"><input id="pw2" name="confirm" type="password">
              <button id="create" type="submit">Create</button></form>`,
            `document.getElementById('pw2').addEventListener('input', (e) => { setTimeout(() => { e.target.value = e.target.value.slice(0, -1); }, 20); });`,
          ),
        );
      case '/login-get':
        return html(
          page(
            'Sign in',
            `<form method="get" action="/login"><label>Email</label><input name="email" type="email" autocomplete="username"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
          ),
        );
      case '/login-xorigin':
        return html(
          page(
            'Sign in',
            `<form method="post" action="http://evil.localhost:${(server.address() as AddressInfo).port}/login"><label>Email</label><input name="email" type="email" autocomplete="username"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
          ),
        );
      case '/js-login':
        return html(
          page(
            'JS login',
            `<div id="box"><input id="ju" type="text" placeholder="user"><input id="jp" type="password"><div id="jgo" role="button">Go</div></div>`,
            `document.getElementById('jgo').addEventListener('click', async () => {
               const body = new URLSearchParams({ email: document.getElementById('ju').value, password: document.getElementById('jp').value });
               await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
               location.href = '/home';
             });`,
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
