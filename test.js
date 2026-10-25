const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture(onLookup = () => ({ status: 200, country: 'United States' }), options = {}) {
  const events = new Map(), domEvents = new Map(), storage = {}, calls = [];
  const names = options.names || ['Alice'];
  const links = names.map(name => {
    let badge = null;
    const link = {
      getAttribute: () => '/' + name,
      querySelector: () => badge,
      get textContent() { return '@' + name + (badge?.textContent || ''); },
      getBoundingClientRect: () => options.offscreen?.includes(name)
        ? { top: 2000, bottom: 2020, left: 0, right: 80 }
        : { top: 40, bottom: 60, left: 0, right: 80 },
      append(element) { badge = element; element.remove = () => { badge = null; }; },
      get badge() { return badge; }
    };
    return link;
  });
  const containers = links.map(link => ({
    matches: () => true, querySelectorAll: () => [link]
  }));
  const document = {
    cookie: 'auth_token=unused; ct0=csrf-from-cookie',
    documentElement: { clientHeight: 1000, clientWidth: 1000 },
    querySelectorAll: () => containers,
    addEventListener(type, fn) {
      if (!domEvents.has(type)) domEvents.set(type, []);
      domEvents.get(type).push(fn);
    },
    emit(type, event) {
      for (const fn of domEvents.get(type) || []) fn(event);
    },
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
    fetch, innerHeight: 1000, innerWidth: 1000,
    emit(type, event = {}) {
      for (const fn of events.get(type) || []) fn(event);
    },
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
  return {
    ctx, document, window, storage, calls, until, containers, links,
    hover(index) {
      document.emit('pointerover', { target: { closest: () => containers[index] } });
    },
    get badge() { return links[0].badge; }
  };
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

test('offscreen accounts do not consume foreground lookup slots', async () => {
  const f = fixture(undefined, { names: ['Alice', 'Bob'], offscreen: ['Alice'] });
  await f.window.fetch('/i/api/graphql/anything/HomeTimeline', {
    headers: { authorization: 'Bearer from-x' }
  });
  await f.until(() => f.storage.locations?.bob?.country === 'United States');
  assert.equal(f.calls.filter(c => c.url.includes('AboutAccountQuery')).length, 1);
  assert.equal(f.calls.find(c => c.url.includes('AboutAccountQuery'))
    .url.includes('screenName%22%3A%22bob%22'), true);
});

test('hovered author jumps ahead of the background queue without a 3s wait', async () => {
  const f = fixture(undefined, { names: ['Alice', 'Bob', 'Carol'] });
  await f.window.fetch('/i/api/graphql/anything/HomeTimeline', {
    headers: { authorization: 'Bearer from-x' }
  });
  await f.until(() => f.calls.filter(c => c.url.includes('AboutAccountQuery')).length === 1);
  f.hover(2);
  await f.until(() => f.calls.filter(c => c.url.includes('AboutAccountQuery')).length >= 2);
  const calls = f.calls.filter(c => c.url.includes('AboutAccountQuery'));
  assert.match(decodeURIComponent(calls[1].url), /"screenName":"carol"/);
  assert.equal(f.storage.locations?.bob, undefined);
});
