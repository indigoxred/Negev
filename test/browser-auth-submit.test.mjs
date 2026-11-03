import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourcePath = process.env.NEGEV_AUTH_SOURCE
  ?? fileURLToPath(new URL('../src/web/public/app.js', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const browsers = [
  process.env.NEGEV_TEST_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = browsers.find((path) => existsSync(path));

function listener(formId, nextMarker) {
  const start = source.indexOf(`byId('${formId}').addEventListener('submit'`);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${formId} submit listener exists`);
  return source.slice(start, end);
}

test('browser completes successful login and registration submit transitions',
  { skip: browser ? false : 'No Chrome or Edge browser installed' }, () => {
    const login = listener('login-form', "byId('register-form').addEventListener");
    const register = listener('register-form', "byId('signout').addEventListener");
    const html = `<!doctype html><meta charset="utf-8">
      <form id="login-form"><input name="username"><input name="password"></form>
      <form id="register-form"><input name="code"><input name="username"><input name="password"></form>
      <pre id="result">pending</pre>
      <script>
        const byId = (id) => document.getElementById(id);
        const calls = [];
        let currentMessage = '';
        let selectedTab = 'register';
        const api = async (path) => {
          calls.push(path);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return {};
        };
        const refreshSession = async () => { calls.push('refreshSession'); return true; };
        const authTab = (register) => { selectedTab = register ? 'register' : 'login'; };
        const message = (value) => { currentMessage = value; };
        ${login}
        ${register}
        const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
        (async () => {
          byId('login-form').elements.username.value = 'login-user';
          byId('login-form').elements.password.value = 'secret';
          byId('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          await settle();
          const loginResult = {
            calls: [...calls], message: currentMessage,
            field: byId('login-form').elements.username.value,
          };
          calls.length = 0;
          currentMessage = '';
          byId('register-form').elements.code.value = 'invite';
          byId('register-form').elements.username.value = 'new-user';
          byId('register-form').elements.password.value = 'secret';
          byId('register-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          await settle();
          byId('result').textContent = JSON.stringify({ login: loginResult,
            register: { calls, message: currentMessage, tab: selectedTab,
              field: byId('register-form').elements.username.value } });
        })();
      </script>`;
    const dir = mkdtempSync(join(tmpdir(), 'negev-browser-auth-'));
    try {
      const fixture = join(dir, 'auth.html');
      writeFileSync(fixture, html);
      const output = execFileSync(browser, [
        '--headless=new', '--no-first-run', '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`,
        '--virtual-time-budget=3000', '--dump-dom',
        new URL(`file:///${fixture.replaceAll('\\', '/')}`).href,
      ], { cwd: dir, encoding: 'utf8', timeout: 45000,
        stdio: ['ignore', 'pipe', 'ignore'] });
      const match = output.match(/<pre id="result">([^<]+)<\/pre>/);
      assert.ok(match, 'browser emitted submit results');
      const result = JSON.parse(match[1].replaceAll('&quot;', '"'));
      assert.deepEqual(result.login.calls, ['/api/login', 'refreshSession']);
      assert.equal(result.login.message, 'Signed in. Search for a show or film.');
      assert.equal(result.login.field, '');
      assert.deepEqual(result.register.calls, ['/api/register']);
      assert.equal(result.register.message, 'Account created. Sign in to continue.');
      assert.equal(result.register.tab, 'login');
      assert.equal(result.register.field, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
