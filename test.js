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


// Layout fixture mirrors the two supplied X structures: a tweet's User-Name
// block and a UserCell with avatar, display name, @handle, Follow and bio links.
function contentFixture(options = {}) {
  const calls = [], listeners = new Map(), badges = new Map();
  const accounts = options.accounts || [
    { handle: 'Alice', name: 'Alice', type: 'User-Name' },
    { handle: 'Bob', name: 'Bob', type: 'User-Name' },
    { handle: 'Carol', name: 'Carol', type: 'User-Name', offscreen: true }
  ];
  const locations = options.locations || {};
  const rows = [], links = [], containers = [], handleLinks = [];
  const orphanBadges = [];

  function element(attrs = {}) {
    return {
      ...attrs,
      dataset: attrs.dataset || {}, style: attrs.style || {},
      parentElement: null,
      get nextElementSibling() {
        const children = this.parentElement?.children || [];
        return children[children.indexOf(this) + 1] || null;
      },
      get previousElementSibling() {
        const children = this.parentElement?.children || [];
        return children[children.indexOf(this) - 1] || null;
      },
      remove() {
        const children = this.parentElement?.children || [];
        const index = children.indexOf(this);
        if (index >= 0) children.splice(index, 1);
        this.parentElement = null;
      },
      getAttribute(key) { return this.attrs?.[key] ?? null; },
      setAttribute(key, value) { (this.attrs ||= {})[key] = value; },
      removeAttribute(key) { if (this.attrs) delete this.attrs[key]; }
    };
  }
  const bounds = acct => acct.offscreen
    ? { top: 1500, bottom: 1520, left: 0, right: 80 }
    : { top: 40, bottom: 60, left: 0, right: 80 };

  for (const acct of accounts) {
    const display = element({
      attrs: { href: '/' + acct.handle, role: 'link' },
      textContent: acct.name,
      getBoundingClientRect: () => bounds(acct)
    });
    const handle = element({
      attrs: { href: '/' + acct.handle, role: 'link', tabindex: '-1' },
      textContent: '@' + acct.handle
    });
    const avatar = element({
      attrs: { href: '/' + acct.handle, role: 'link', tabindex: '-1' },
      textContent: ''
    });
    const row = {
      style: {},
      children: [display],
      insertions: 0,
      insertBefore(child, anchor) {
        this.insertions++;
        if (child.parentElement) child.remove();
        const at = anchor ? this.children.indexOf(anchor) : this.children.length;
        this.children.splice(at < 0 ? this.children.length : at, 0, child);
        child.parentElement = this;
        badges.set(acct.handle, child);
      }
    };
    display.parentElement = row;
    const bioLinks = (acct.bio || []).map(name => element({
      attrs: { href: '/' + name, role: 'link' },
      textContent: '@' + name
    }));
    const oldBadges = [];
    if (acct.legacyBioBadge) {
      const old = element({
        dataset: { xAccountFlag: 'true', xAccountHandle: 'ka_xa_' },
        textContent: 'East Asia'
      });
      old.parentElement = { children: [old] };
      oldBadges.push(old);
      orphanBadges.push(old);
    }
    const allLinks = [avatar, display, handle, ...bioLinks];
    const container = {
      type: acct.type,
      matches() { return true; },
      querySelectorAll(selector) {
        if (selector === 'a[href]') return allLinks;
        if (selector === '[data-x-account-flag]') {
          return [
            ...row.children.filter(x => x.dataset?.xAccountFlag === 'true'),
            ...oldBadges.filter(x => x.parentElement)
          ];
        }
        return [];
      }
    };
    display.closest = selector => selector === '[data-testid="UserCell"]' &&
      acct.type === 'UserCell' ? container : null;
    containers.push(container);
    rows.push(row);
    links.push(display);
    handleLinks.push(handle);
  }
  const document = {
    documentElement: { clientHeight: 800, clientWidth: 900 },
    querySelectorAll: selector => selector.startsWith('[data-testid=')
      ? containers : [],
    addEventListener(name, fn) { listeners.set(name, fn); },
    createElement: () => element({ textContent: '' })
  };
  const window = {
    innerHeight: 800, innerWidth: 900,
    addEventListener(name, fn) { listeners.set(name, fn); }
  };
  const browser = {
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        if (options.lookup) return options.lookup(message);
        return {
          success: true,
          country: Object.hasOwn(locations, message.username)
            ? locations[message.username] : 'Japan',
          accurate: true
        };
      }
    }
  };
  load('content.js', {
    document, window, browser, Date, Intl, URL,
    setTimeout, clearTimeout,
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    MutationObserver: class { observe() {} }
  });
  const badge = index => rows[index].children.find(node => node.dataset?.xAccountFlag);
  return { calls, listeners, links, handleLinks, rows, containers,
    badges, badge, orphanBadges };
}

test('only visible account headers are looked up, not offscreen entries', async () => {
  const f = contentFixture();
  await waitFor(() => f.badge(0)?.textContent === '🇯🇵' &&
    f.badge(1)?.textContent === '🇯🇵');
  assert.deepEqual(f.calls.map(c => c.username).sort(), ['alice','bob']);
  assert.equal(f.badge(2).textContent, '');
});

test('flag occupies a fixed-width slot immediately BEFORE display-name link', async () => {
  const f = contentFixture();
  await waitFor(() => f.badge(0)?.textContent === '🇯🇵');
  const [badge, name] = f.rows[0].children;
  assert.equal(name, f.links[0]);
  assert.equal(f.badge(0), badge);
  assert.equal(f.rows[0].style.flexDirection, 'row');
  assert.equal(f.rows[0].style.alignItems, 'center');
  assert.equal(badge.style.width, '5.5rem');
  assert.equal(badge.style.flex, '0 0 5.5rem');
  assert.equal(badge.style.backgroundColor, 'transparent');
  assert.equal(badge.style.paddingInline, '0');
  assert.equal(name.textContent, 'Alice');
});

test('broad geographical regions have square light-background chips', async () => {
  const f = contentFixture({ locations: { alice: 'East Asia', bob: 'Europe' } });
  await waitFor(() => f.badge(0)?.textContent === 'East Asia' &&
    f.badge(1)?.textContent === 'Europe');
  const badge = f.badge(0);
  assert.equal(badge.style.backgroundColor, '#f5f5f5');
  assert.equal(badge.style.color, '#171717');
  assert.equal(badge.style.paddingInline, '0.35rem');
  assert.equal(badge.style.borderRadius, '0');
  assert.equal(badge.style.boxSizing, 'border-box');
  assert.equal(badge.style.width, '5.5rem');
  assert.equal(badge.style.textOverflow, 'ellipsis');
  assert.equal(badge.style.whiteSpace, 'nowrap');
  assert.equal(badge.title, 'Account based in East Asia (according to X)');
});

test('the fixed-width placeholder precedes the name without layout shift', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = contentFixture({ lookup: () => pending });
  const slot = f.badge(0);
  assert.equal(f.rows[0].children[0], slot);
  assert.equal(f.rows[0].children[1], f.links[0]);
  assert.equal(slot.textContent, '');
  assert.equal(slot.style.width, '5.5rem');
  assert.match(slot.style.backgroundImage, /linear-gradient/);
  finish({ success: true, country: 'East Asia' });
  await waitFor(() => slot.textContent === 'East Asia');
  assert.equal(f.rows[0].children[0], slot);
  assert.equal(slot.style.width, '5.5rem');
  assert.equal(slot.style.backgroundImage, 'none');
  assert.equal(slot.style.backgroundColor, '#f5f5f5');
  assert.equal(f.rows[0].insertions, 1);
});

test('empty and failed lookups leave a blank reserved slot', async () => {
  for (const result of [
    { success: true, country: null },
    { success: false }
  ]) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = contentFixture({ lookup: () => pending });
    const slot = f.badge(0);
    finish(result);
    await waitFor(() => slot.style.backgroundImage === 'none');
    assert.equal(slot.textContent, '');
    assert.equal(f.rows[0].children[0], slot);
    assert.equal(slot.style.width, '5.5rem');
    assert.equal(slot.style.backgroundColor, 'transparent');
  }
});

test('rescans reuse existing slot rather than duplicating it', async () => {
  const f = contentFixture({ locations: { alice: 'East Asia' } });
  await waitFor(() => f.badge(0)?.textContent === 'East Asia');
  const slot = f.badge(0);
  f.listeners.get('scroll')();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.badge(0), slot);
  assert.equal(f.rows[0].children.length, 2);
  assert.equal(f.rows[0].insertions, 1);
});

test('UserCell selects the display name and ignores its biography @mentions', async () => {
  const f = contentFixture({
    accounts: [{
      type: 'UserCell', handle: 'AyatsunoYuni', name: '유니 Yuni',
      bio: ['StelLive_kr', 'rainydayinabi', 'KA_XA_'],
      legacyBioBadge: true
    }],
    locations: { ayatsunoyuni: 'Japan' }
  });
  await waitFor(() => f.badge(0)?.textContent === '🇯🇵');
  assert.deepEqual(f.calls.map(call => call.username), ['ayatsunoyuni']);
  assert.equal(f.rows[0].children[0], f.badge(0));
  assert.equal(f.rows[0].children[1], f.links[0]);
  assert.equal(f.links[0].textContent, '유니 Yuni');
  assert.equal(f.handleLinks[0].textContent, '@AyatsunoYuni');
  assert.equal(f.orphanBadges[0].parentElement, null, 'remove old bio decorations');
});

test('invalid bio-only containers do not start network lookups', async () => {
  const f = contentFixture({
    accounts: [{ type: 'UserCell', handle: 'NoName', name: '',
      bio: ['OtherAccount'] }]
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows[0].children.length, 1);
});
