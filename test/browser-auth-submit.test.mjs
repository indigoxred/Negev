import { findTestBrowser, browserSkipReason } from './helpers/browser-executable.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAuthController } from '../src/web/public/auth-controller.mjs';
const epochSource = readFileSync(new URL('../src/web/public/response-epoch.mjs', import.meta.url),'utf8').replace('export function','function');
const browser = findTestBrowser();

test('browser completes successful login and registration submit transitions',
  { skip: browser ? false : browserSkipReason }, () => {


    const html = `<!doctype html><meta charset="utf-8">
      <form id="login-form"><input name="username"><input name="password"></form>
      <form id="register-form"><input name="code"><input name="username"><input name="password"></form>
      <button id="login-tab"></button><button id="register-tab"></button><form id="reset-form" hidden></form><pre id="result">pending</pre>
      <script>
        const byId = (id) => document.getElementById(id);
        const calls = [];
        ${epochSource}
        const sessionResponses=createResponseEpoch(), priorSession=sessionResponses.current();
        let currentMessage = '';

        let failRegistration=false;
        const api = async (path) => {
          calls.push(path);
          await new Promise((resolve) => setTimeout(resolve, 1));
          if(path==='/api/register'&&failRegistration){const e=new Error('Username must be 3–32 characters, start with a letter, and use only letters, numbers or underscores.');e.field='username';throw e;}
          return {};
        };
        const refreshSession = async () => { if(sessionResponses.isCurrent(priorSession))throw Error('Old session generation survived login');calls.push('refreshSession'); return true; };

        const message = (value) => { currentMessage = value; };
        const auth = (${createAuthController.toString()})({byId,api,message,sessionResponses,state:{user:null},refreshSession,clearWorkspace(){}});
        byId('login-form').addEventListener('submit',auth.handleLoginSubmit);
        byId('register-form').addEventListener('submit',auth.handleRegisterSubmit);
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
          const registerResult={calls:[...calls],message:currentMessage,tab:byId('register-form').hidden?'login':'register',field:byId('register-form').elements.username.value};
          // Success switches to login. Reopen registration as a user would
          // before checking validation focus on the next submission.
          auth.authTab(true);
          failRegistration=true;byId('register-form').elements.username.value='bad name';
          byId('register-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();
          byId('result').textContent = JSON.stringify({ login: loginResult,register:registerResult,
            failure:{message:currentMessage,field:byId('register-form').elements.username.value,focused:document.activeElement===byId('register-form').elements.username} });
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
      assert.match(result.failure.message,/Username must be 3–32/);
      assert.equal(result.failure.field,'bad name');assert.equal(result.failure.focused,true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
