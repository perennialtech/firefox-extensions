const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture(onLookup = () => ({ status: 200, country: 'United States' })) {
  const events = new Map(), storage = {}, calls = [];
  let badge = null;
  const link = {
    getAttribute: () => '/Alice',
    querySelector: () => badge,
    get textContent() { return '@Alice' + (badge?.textContent || ''); },
    append(element) { badge = element; element.remove = () => { badge = null; }; }
  };
  const document = {
    cookie: 'auth_token=unused; ct0=csrf-from-cookie', documentElement: {},
    querySelectorAll: () => [{ querySelectorAll: () => [link] }],
    createElement: () => ({ dataset: {}, style: {}, textContent: '', setAttribute() {} })
  };
  const fetch = async (url, options) => {
    const address = String(url);
    calls.push({ url: address, options });
    const params = address.includes('AboutAccountQuery') ? onLookup(address) : {};
    const { status = 200, country = 'United States', errors = false } = params;
    return {
      ok: status >= 200 && status < 300, status,
      headers: new Headers({ 'x-rate-limit-remaining': '49' }),
      json: async () => errors ? { errors: [{ message: 'failed' }] } : {
        data: { user_result_by_screen_name: {
          result: { about_profile: { account_based_in: country } }
        } }
      }
    };
  };
  class XHR {
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    send() {}
  }
  const ctx = {
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    document, XMLHttpRequest: XHR,
    Headers, Request, URL, Intl, Date, setTimeout, clearTimeout,
    browser: { storage: { local: {
      get: async key => ({ [key]: storage[key] }),
      set: async value => Object.assign(storage, value)
    } } },
    MutationObserver: class { observe() {} }
  };
  const window = {
    fetch,
    addEventListener(type, fn) {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push(fn);
    },
    postMessage(data, origin) {
      for (const fn of events.get('message') || []) {
        fn({ source: window, origin, data });
      }
    }
  };
  ctx.window = window;
  const sandbox = vm.createContext(ctx);
  for (const file of ['page.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(__dirname + '/' + file, 'utf8'), sandbox, { filename: file });
  }
  async function until(predicate) {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 1500) throw new Error('Timed out waiting for state');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return { ctx, window, storage, calls, until, get badge() { return badge; } };
}

test('captures authorization without a CSRF header and displays a flag', async () => {
  const f = fixture();
  await f.window.fetch('/i/api/graphql/anything/HomeTimeline', {
    headers: { authorization: 'Bearer from-x' }
  });
  await f.until(() => f.badge?.textContent === '🇺🇸');
  await f.until(() => f.storage.locations?.alice?.country === 'United States');
  const lookup = f.calls.find(call => call.url.includes('AboutAccountQuery'));
  assert.equal(lookup.options.headers.authorization, 'Bearer from-x');
  assert.equal(lookup.options.headers['x-csrf-token'], 'csrf-from-cookie');
  assert.equal(lookup.options.credentials, 'include');
  assert.ok(!JSON.stringify(f.storage).includes('from-x'));
});

test('captures XHR authorization as well as fetch', async () => {
  const f = fixture();
  const xhr = new f.ctx.XMLHttpRequest();
  xhr.open('GET', '/i/api/graphql/anything/HomeTimeline');
  xhr.setRequestHeader('authorization', 'Bearer via-xhr');
  xhr.send();
  await f.until(() => f.badge?.textContent === '🇺🇸');
  assert.equal(f.calls.find(call => call.url.includes('AboutAccountQuery'))
    .options.headers.authorization, 'Bearer via-xhr');
});

test('falls back when the first AboutAccountQuery ID returns 404', async () => {
  const f = fixture(url => ({
    status: url.includes('XRqGa7EeokUU5kppkh13EA') ? 404 : 200,
    country: 'Japan'
  }));
  await f.window.fetch('/i/api/graphql/anything/HomeTimeline', {
    headers: { authorization: 'Bearer from-x' }
  });
  await f.until(() => f.badge?.textContent === '🇯🇵');
  const lookups = f.calls.filter(call => call.url.includes('AboutAccountQuery'));
  assert.equal(lookups.length, 2);
  assert.match(lookups[1].url, /zs_jFPFT78rBpXv9Z3U2YQ/);
});

test('does not persist an unsuccessful GraphQL result as missing location', async () => {
  const f = fixture(() => ({ errors: true }));
  await f.window.fetch('/i/api/graphql/anything/HomeTimeline', {
    headers: { authorization: 'Bearer from-x' }
  });
  await f.until(() => f.calls.some(call => call.url.includes('AboutAccountQuery')));
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(f.badge, null);
  assert.equal(f.storage.locations, undefined);
});

test('caches a legitimately empty location for less than a day', async () => {
  const f = fixture(() => ({ country: null }));
  await f.window.fetch('/i/api/graphql/anything/HomeTimeline', {
    headers: { authorization: 'Bearer from-x' }
  });
  await f.until(() => f.storage.locations?.alice?.country === null);
  assert.equal(f.badge, null);
  const age = f.storage.locations.alice.expires - Date.now();
  assert.ok(age > 5 * 3600000 && age < 7 * 3600000);
});
