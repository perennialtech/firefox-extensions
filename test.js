// No dependencies, real extension scripts executed in isolated VM worlds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(name, context) {
  vm.runInNewContext(fs.readFileSync(__dirname + '/' + name, 'utf8'), context, {
    filename: name
  });
}

function response(status = 200, data = { code: 200, about_account: { based_in: 'Japan', location_accurate: true } }, headers = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: new Headers(headers), json: async () => data };
}

function backgroundFixture(fetchImpl = async () => response(), storage = {}) {
  const calls = [], handlers = [];
  const browser = {
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .map(key => [key, storage[key]]));
      },
      async set(value) { Object.assign(storage, value); }
    } },
    runtime: { onMessage: { addListener(fn) { handlers.push(fn); } } }
  };
  load('background.js', {
    browser, Headers, AbortController, Date, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options);
    }
  });
  async function send(username, priority = false) {
    return handlers[0]({ type: 'lookup', username, priority });
  }
  return { browser, storage, calls, send };
}

async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('FxTwitter about endpoint, no cookies, country and accuracy returned', async () => {
  const f = backgroundFixture();
  assert.equal(JSON.stringify(await f.send('alice')), JSON.stringify({
    success: true, country: 'Japan', accurate: true
  }));
  assert.equal(f.calls[0].url, 'https://api.fxtwitter.com/2/profile/alice/about');
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(f.calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(f.calls[0].options.headers, undefined);
  await waitFor(() => !!f.storage['fxtwitter-locations-v1']?.alice);
  assert.equal(f.storage['fxtwitter-locations-v1'].alice.country, 'Japan');
});

test('case-insensitive handle cache avoids repeat requests', async () => {
  const f = backgroundFixture();
  assert.equal((await f.send('ALICE')).country, 'Japan');
  assert.equal((await f.send('Alice')).country, 'Japan');
  assert.equal(f.calls.length, 1);
});

test('coalesces concurrent lookups across tabs', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = backgroundFixture(async () => { await gate; return response(); });
  const first = f.send('bob');
  const second = f.send('bob');
  await waitFor(() => f.calls.length === 1);
  release();
  const values = await Promise.all([first, second]);
  assert.equal(values[0].country, 'Japan');
  assert.equal(values[1].country, 'Japan');
  assert.equal(f.calls.length, 1);
});

test('invalid handles are rejected before any request', async () => {
  const f = backgroundFixture();
  for (const handle of ['', '../secret', 'name/status/1', 'x'.repeat(16)]) {
    assert.equal(await f.send(handle), undefined);
  }
  assert.equal(f.calls.length, 0);
});

test('missing about metadata caches a valid empty answer', async () => {
  const f = backgroundFixture(async () => response(200, { code: 200, message: 'OK' }));
  const result = await f.send('alice');
  assert.equal(result.success, true);
  assert.equal(result.country, null);
  await f.send('alice');
  assert.equal(f.calls.length, 1);
});

test('HTTP 200 with API error is not cached as an empty account', async () => {
  const f = backgroundFixture(async () => response(200, { code: 500, message: 'Upstream error' }));
  assert.equal((await f.send('alice')).success, false);
  assert.equal((await f.send('alice')).success, false);
  assert.equal(f.calls.length, 2);
});

test('HTTP 429 pauses the service and persists cooldown across background restarts', async () => {
  const f = backgroundFixture(async () => response(429, { code: 429 }, { 'retry-after': '40' }));
  const value = await f.send('alice');
  assert.equal(value.success, false);
  assert.ok(value.retryAt - Date.now() > 39000);
  const next = await f.send('bob');
  assert.equal(next.retryAt, value.retryAt);
  assert.equal(f.calls.length, 1);
  const again = backgroundFixture(async () => response(), f.storage);
  const afterRestart = await again.send('carol');
  assert.equal(afterRestart.retryAt, value.retryAt);
  assert.equal(again.calls.length, 0);
});

function contentFixture(options = {}) {
  const calls = [], listeners = new Map(), badges = new Map();
  const handles = options.handles || ['Alice', 'Bob', 'Carol'];
  const regions = options.regions || {};
  const links = [];
  const containers = [];
  const rows = [];
  // Minimal DOM representation of the supplied X HTML: a flex row containing
  // a handle-wrapper div, then the · separator, then a date div. The handle
  // <a> owns a text div, but must NOT own our location badge.
  for (const [index, name] of handles.entries()) {
    const slot = {
      children: [], parentElement: null,
      get nextSibling() {
        const children = this.parentElement?.children || [];
        return children[children.indexOf(this) + 1] || null;
      }
    };
    const dot = { textContent: '·', parentElement: null };
    const date = { textContent: 'Mar 22, 2024', parentElement: null };
    const row = {
      children: [slot, dot, date],
      insertions: 0,
      insertBefore(child, before) {
        this.insertions++;
        if (child.parentElement) child.remove();
        const position = before ? this.children.indexOf(before) : -1;
        this.children.splice(position < 0 ? this.children.length : position, 0, child);
        child.parentElement = this;
        child.remove = () => {
          const at = this.children.indexOf(child);
          if (at !== -1) this.children.splice(at, 1);
          child.parentElement = null;
        };
        badges.set(name, child);
      }
    };
    for (const child of row.children) child.parentElement = row;
    const link = {
      name, parentElement: slot,
      getAttribute() { return '/' + name; },
      querySelector: () => null,
      get textContent() { return '@' + name; },
      getBoundingClientRect() {
        return { top: index === 2 ? 1400 : 50, bottom: index === 2 ? 1420 : 70,
          left: 0, right: 90 };
      }
    };
    const container = { matches: () => true, querySelectorAll: () => [link] };
    links.push(link);
    containers.push(container);
    rows.push(row);
  }
  const doc = {
    documentElement: { clientHeight: 800, clientWidth: 900 },
    querySelectorAll: () => containers,
    createElement: () => ({
      dataset: {}, style: {}, textContent: '', parentElement: null,
      setAttribute() {},
      get previousElementSibling() {
        const children = this.parentElement?.children || [];
        return children[children.indexOf(this) - 1] || null;
      }
    }),
    addEventListener(name, fn) { listeners.set(name, fn); }
  };
  const win = { innerHeight: 800, innerWidth: 900,
    addEventListener(name, fn) { listeners.set(name, fn); } };
  const browser = {
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        const country = Object.hasOwn(regions, message.username)
          ? regions[message.username]
          : message.username === 'bob' ? 'United States' : 'Japan';
        return { success: true, country, accurate: true };
      }
    }
  };
  load('content.js', {
    browser, window: win, document: doc,
    Intl, Date, setTimeout, clearTimeout, URL,
    location: { href: 'https://x.com/home', origin: 'https://x.com' },
    MutationObserver: class { observe() {} }
  });
  return { calls, links, containers, badges, listeners, rows };
}

test('content script only requests visible X handles and displays returned flags', async () => {
  const f = contentFixture();
  await waitFor(() => f.badges.get('Alice')?.textContent === '🇯🇵' &&
    f.badges.get('Bob')?.textContent === '🇺🇸');
  assert.equal(f.calls.length, 2);
  assert.equal(f.badges.has('Carol'), false);
  assert.ok(f.calls.every(call => call.type === 'lookup'));
});

test('flags are siblings of the handle wrapper and remain in X’s horizontal row', async () => {
  const f = contentFixture();
  await waitFor(() => f.badges.get('Alice')?.textContent === '🇯🇵');
  const row = f.rows[0];
  const badge = f.badges.get('Alice');
  assert.equal(row.children[0], f.links[0].parentElement);
  assert.equal(row.children[1], badge);
  assert.equal(row.children[2].textContent, '·');
  assert.equal(badge.parentElement, row);
  assert.equal(f.links[0].textContent, '@Alice');
  assert.equal(badge.style.display, 'inline-flex');
  assert.equal(badge.style.whiteSpace, 'nowrap');
  assert.equal(badge.style.flexShrink, '0');
});

test('non-country locations render as readable, non-wrapping region text', async () => {
  const f = contentFixture({ regions: { alice: 'East Asia', bob: 'Europe' } });
  await waitFor(() => f.badges.get('Alice')?.textContent === 'East Asia' &&
    f.badges.get('Bob')?.textContent === 'Europe');
  const badge = f.badges.get('Alice');
  assert.equal(badge.title, 'Account based in East Asia (according to X)');
  assert.equal(badge.style.flexShrink, '1');
  assert.equal(badge.style.textOverflow, 'ellipsis');
  assert.equal(f.rows[0].children[1], badge);
});

test('subsequent scans reuse the badge instead of adding duplicates', async () => {
  const f = contentFixture({ regions: { alice: 'East Asia' } });
  await waitFor(() => f.badges.get('Alice')?.textContent === 'East Asia');
  const badge = f.badges.get('Alice');
  f.listeners.get('scroll')();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.rows[0].children.filter(node => node.dataset?.xAccountFlag).length, 1);
  assert.equal(f.rows[0].children[1], badge);
  assert.equal(f.rows[0].insertions, 1, 'repeat scans must not move existing badges');
});
