// ISOLATED world: detect account handles, pace lookups and display cached flags.
(() => {
  'use strict';

  const CHANNEL = 'x-account-location-flags';
  const CACHE_KEY = 'locations';
  const CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
  const EMPTY_CACHE_AGE = 6 * 60 * 60 * 1000;
  const ERROR_CACHE_AGE = 2 * 60 * 1000;
  const REQUEST_GAP = 3000;
  const MAX_QUEUE = 200;
  const cache = new Map();
  const queued = new Set();
  const queue = [];
  const waiting = new Map();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const countryCodes = new Map([
    ['united states of america', 'US'], ['usa', 'US'], ['uk', 'GB'],
    ['russia', 'RU'], ['south korea', 'KR'], ['north korea', 'KP'],
    ['korea', 'KR'], ['turkey', 'TR'], ['czech republic', 'CZ'],
    ['taiwan', 'TW'], ['hong kong', 'HK']
  ]);
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = names.of(code);
      if (name !== code) countryCodes.set(name.toLowerCase(), code);
    }
  }

  let ready = false;
  let running = false;
  let retryAt = 0;
  let nextRequestAt = 0;
  let sequence = 0;
  let scanTimer = null;
  let persistTimer = null;

  function flagFor(country) {
    if (typeof country !== 'string') return null;
    const trimmed = country.trim().toLowerCase();
    const code = countryCodes.get(trimmed) ||
      (/^[a-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : null);
    if (!code || !/^[A-Z]{2}$/.test(code)) return null;
    return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
  }

  function findHandles() {
    const matches = [];
    const containers = document.querySelectorAll(
      '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"]'
    );
    for (const container of containers) {
      for (const link of container.querySelectorAll('a[href]')) {
        let path;
        try {
          const url = new URL(link.getAttribute('href'), location.href);
          if (url.origin !== location.origin) continue;
          path = url.pathname;
        } catch (_) { continue; }
        const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(path);
        if (!match) continue;
        const badge = link.querySelector('[data-x-account-flag]');
        const text = link.textContent.replace(badge?.textContent || '', '').trim();
        if (text.toLowerCase() !== '@' + match[1].toLowerCase()) continue;
        matches.push({ link, username: match[1].toLowerCase() });
      }
    }
    return matches;
  }

  function enqueue(username) {
    if (queued.has(username) || queue.length >= MAX_QUEUE) return;
    queued.add(username);
    queue.push(username);
    void processQueue();
  }

  function paint() {
    const now = Date.now();
    for (const { link, username } of findHandles()) {
      const entry = cache.get(username);
      const current = entry?.expires > now ? entry : null;
      const flag = current ? flagFor(current.country) : null;
      let badge = link.querySelector('[data-x-account-flag]');
      if (flag) {
        if (!badge) {
          badge = document.createElement('span');
          badge.dataset.xAccountFlag = 'true';
          badge.style.marginInlineStart = '0.3em';
          badge.style.display = 'inline-block';
          badge.setAttribute('aria-label', 'Account based in ' + current.country);
          link.append(badge);
        }
        if (badge.textContent !== flag) badge.textContent = flag;
        badge.title = 'Account based in ' + current.country;
      } else if (badge) {
        badge.remove();
      }
      if (!current) enqueue(username);
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      paint();
    }, 150);
  }

  function persist() {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const entries = [...cache].filter(([, value]) => !value.transient &&
        value.expires > Date.now());
      void browser.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) })
        .catch(() => {});
    }, 300);
  }

  function lookup(username) {
    const id = ++sequence;
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        waiting.delete(id);
        resolve({ success: false });
      }, 12000);
      waiting.set(id, value => {
        clearTimeout(timeout);
        resolve(value);
      });
      window.postMessage({ channel: CHANNEL, type: 'lookup', id, username }, location.origin);
    });
  }

  async function processQueue() {
    if (!ready || running) return;
    running = true;
    try {
      while (ready && queue.length) {
        const delay = Math.max(0, retryAt - Date.now(), nextRequestAt - Date.now());
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const username = queue.shift();
        nextRequestAt = Date.now() + REQUEST_GAP;
        const result = await lookup(username);
        if (result.success) {
          queued.delete(username);
          cache.set(username, {
            country: result.country,
            expires: Date.now() + (result.country ? CACHE_AGE : EMPTY_CACHE_AGE)
          });
          persist();
          scheduleScan();
        } else if (!result.retryAt) {
          queued.delete(username);
          cache.set(username, {
            country: null, expires: Date.now() + ERROR_CACHE_AGE, transient: true
          });
        }
        if (result.retryAt) {
          retryAt = Math.max(retryAt, result.retryAt);
          if (!result.success) queue.unshift(username);
        }
      }
    } finally {
      running = false;
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== CHANNEL) return;
    if (event.data.type === 'ready') {
      ready = true;
      void processQueue();
    } else if (event.data.type === 'result') {
      const resolve = waiting.get(event.data.id);
      if (resolve) {
        waiting.delete(event.data.id);
        resolve(event.data);
      }
    }
  });

  async function start() {
    try {
      const stored = (await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
      for (const [name, entry] of Object.entries(stored)) {
        if (/^[a-z0-9_]{1,15}$/.test(name) && entry?.expires > Date.now() &&
            (entry.country === null || typeof entry.country === 'string')) {
          cache.set(name, entry);
        }
      }
    } catch (_) {}
    paint();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true
    });
    window.postMessage({ channel: CHANNEL, type: 'hello' }, location.origin);
  }
  void start();
})();
