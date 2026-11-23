import test from 'node:test';
import assert from 'node:assert/strict';
import {findTestBrowser} from './helpers/browser-executable.mjs';
test('Windows browser fixtures stay disabled without probing or launching a fresh profile',()=>{
  let probes=0;
  assert.equal(findTestBrowser({platform:'win32',browser:'explicit-edge',exists:()=>{probes++;return true}}),undefined);
  assert.equal(probes,0);
});
test('Linux CI retains explicit executable selection',()=>assert.equal(findTestBrowser({platform:'linux',browser:'/custom/chrome',exists:p=>p==='/custom/chrome'}),'/custom/chrome'));
test('Linux CI still discovers installed Chrome or Chromium',()=>assert.equal(findTestBrowser({platform:'linux',exists:p=>p==='/usr/bin/chromium'}),'/usr/bin/chromium'));
test('missing Linux browser leaves the fixtures skipped',()=>assert.equal(findTestBrowser({platform:'linux',exists:()=>false}),undefined));
