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
  /** every request path+query, to prove no value ever reached a URL */
  requested: string[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const requested: string[] = [];
  const passkeyCounters = new Map<string, number>();
  const page = (title: string, body: string, script = '') =>
    `<!doctype html><html><head><meta charset=utf-8><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

  const loginForm = (extra = '', action = '/login') => `
    <form method="post" action="${action}">
      ${extra}
      <label for="em">Email</label><input id="em" name="email" type="email" autocomplete="username">
      <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>`;

  const step2 = (email: string) =>
    page(
      'Step 2',
      `<form method="post" action="/login"><input type="hidden" name="email" value="${email}"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
    );

  const outsideForm = `<form id="lf" method="get" action="/login"><input id="em" name="email" type="email"><input id="pw" name="password" type="password"></form>`;
  const outsideScript = `const trap = new URLSearchParams(location.search).get('trap');
    document.getElementById('go').addEventListener('click', async () => {
      const f = document.getElementById('lf');
      if (trap === 'enter') f.requestSubmit(); // the path an Enter key's implicit submission takes
      if (trap === 'submit') f.submit(); // no submit event: only the navigation guard stops it
      const body = new URLSearchParams({ email: document.getElementById('em').value, password: document.getElementById('pw').value });
      await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      location.href = '/home';
    });`;

  const server: Server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const u = new URL(req.url ?? '/', 'http://x');
    requested.push(req.url ?? '');
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
        if (u.pathname === '/step2') {
          html(step2(fields.email ?? ''));
          return;
        }
        if (u.pathname === '/passkey') {
          // strict relying party (SimpleWebAuthn rules): the signature counter must grow unless both it and
          // the stored one are 0, and the backup-eligible flag must match registration (Bitwarden: BE=1).
          // The test verifies the signature itself.
          const ad = Buffer.from(fields.authenticatorData ?? '', 'base64url');
          const count = ad.length >= 37 ? ad.readUInt32BE(33) : -1;
          const stored = passkeyCounters.get(fields.id) ?? 0;
          const ok = count >= 0 && !((count > 0 || stored > 0) && count <= stored) && (ad[32] & 0x08) !== 0;
          if (ok) passkeyCounters.set(fields.id, count);
          fields.verdict = ok ? 'accepted' : 'rejected';
          res.writeHead(ok ? 200 : 400).end();
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
            `<form method="post" action="/step2"><label>Email</label><input name="email" type="email" autocomplete="username"><button type="submit">Next</button></form>`,
          ),
        );
      case '/step2':
        return html(step2(u.searchParams.get('email') ?? ''));
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
      case '/signup-confirm':
        // password + confirmation, no autocomplete hint: still a sign-up shape
        return html(
          page(
            'Sign up',
            `<form method="post" action="/login"><label>Email</label><input name="email" type="email" autocomplete="username"><label>Password</label><input name="password" type="password"><label>Confirm password</label><input name="confirm" type="password"><button type="submit">Sign up</button></form>`,
          ),
        );
      case '/new-password':
        return html(
          page(
            'Change password',
            `<form method="post" action="/login"><label>Email</label><input name="email" type="email" autocomplete="username"><label>Password</label><input name="password" type="password" autocomplete="new-password"><button type="submit">Save</button></form>`,
          ),
        );
      case '/split':
        return html(
          page(
            'Split',
            `<form method="post" action="/login"><label>Email</label><input name="email" type="email" autocomplete="username"><button type="submit">Next</button></form>
             <form method="post" action="/login"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
          ),
        );
      case '/two-submits':
        return html(
          page(
            'Two submits',
            `<form method="post" action="/login"><label>Email</label><input name="email" type="email" autocomplete="username"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button><button type="submit">Sign in with SSO</button></form>`,
          ),
        );
      case '/formless':
        return html(
          page(
            'Formless',
            `<label>Email</label><input name="email" type="email" autocomplete="username"><label>Password</label><input name="password" type="password" autocomplete="current-password"><button type="button">Sign in</button>`,
          ),
        );
      case '/late-enable':
        // submit starts disabled; the page enables it once both fields hold a value
        return html(
          page(
            'Late enable',
            `<h1>Sign in</h1>${loginForm().replace('<button type="submit">', '<button type="submit" disabled>')}`,
            `document.addEventListener('input', () => {
              document.querySelector('button').disabled = !(document.querySelector('#em').value && document.querySelector('#pw').value);
            });`,
          ),
        );
      case '/always-disabled':
        return html(
          page(
            'Always disabled',
            `<h1>Sign in</h1>${loginForm().replace('<button type="submit">', '<button type="submit" disabled>')}`,
          ),
        );
      case '/inert-submit':
        return html(
          page(
            'Inert submit',
            `<h1>Sign in</h1>${loginForm().replace('<button type="submit">Sign in</button>', '<div inert><button type="submit">Sign in</button></div>')}`,
          ),
        );
      case '/outside':
        // eccang-like: fields in a GET <form>, the login <a> outside it, handled in JS (?trap= also fires a native submit)
        return html(
          page('Outside', `${outsideForm}<a id="go" href="javascript:;">Log in</a>`, outsideScript),
        );
      case '/outside-formonly':
        return html(page('Outside', outsideForm));
      case '/outside-btn':
        return html(page('Button', '<a id="go" href="javascript:;">Log in</a>'));
      case '/outside-split':
        // fields in the top document, the login link inside a child frame of another origin
        return html(
          page(
            'Split',
            `${outsideForm}<iframe src="http://cdn.localhost:${(server.address() as AddressInfo).port}/outside-btn"></iframe>`,
          ),
        );
      case '/outside-framed':
        // fields inside a bound child frame, the login link in the top document
        return html(
          page(
            'Framed',
            `<a id="go" href="javascript:;">Log in</a><iframe src="http://cdn.localhost:${(server.address() as AddressInfo).port}/outside-formonly"></iframe>`,
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
    requested,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
