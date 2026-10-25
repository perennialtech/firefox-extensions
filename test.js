// Dependency-free smoke test for the MAIN/ISOLATED message flow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const events = new Map();
const storage = {};
const calls = [];
let badge = null;
const link = {
  getAttribute: () => '/Alice',
  querySelector: () => badge,
  get textContent() { return '@Alice' + (badge?.textContent || ''); },
  append(element) { badge = element; element.remove = () => { badge = null; }; }
};
const context = {
  location: { origin: 'https://x.com', href: 'https://x.com/home' },
  Headers, Request, URL, Intl, setTimeout, clearTimeout,
  browser: { storage: { local: {
    get: async (key) => ({ [key]: storage[key] }),
    set: async (value) => Object.assign(storage, value)
  } } },
  document: {
    documentElement: {},
    querySelectorAll: () => [{ querySelectorAll: () => [link] }],
    createElement: () => ({ dataset: {}, style: {}, textContent: '' })
  },
  MutationObserver: class { observe() {} }
};
context.window = {
  fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: {
        result: { about_profile: { account_based_in: 'United States' } }
      } } })
    };
  },
  addEventListener: (name, fn) => {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(fn);
  },
  postMessage: (data, origin) => {
    for (const fn of events.get('message') || []) {
      fn({ source: context.window, origin, data });
    }
  }
};

const sandbox = vm.createContext(context);
for (const name of ['page.js', 'content.js']) {
  vm.runInContext(fs.readFileSync(`${__dirname}/${name}`, 'utf8'), sandbox, { filename: name });
}

(async () => {
  await context.window.fetch('https://x.com/i/api/graphql/some-other-query', {
    headers: { authorization: 'Bearer private', 'x-csrf-token': 'private' }
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(badge?.textContent, '🇺🇸');
  assert.equal(calls.length, 2, 'one X fetch and one account lookup');
  assert.equal(JSON.parse(new URL(calls[1].url).searchParams.get('variables')).screenName, 'alice');
  assert.equal(storage.locations.alice.country, 'United States');
  assert.ok(!JSON.stringify(storage).includes('private'), 'no auth secrets persisted');
  console.log('PASS: authenticated lookup, flag rendering, and safe cache');
})().catch(error => { console.error(error); process.exitCode = 1; });
