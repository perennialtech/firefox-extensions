// ISOLATED world: find account handles, queue lookups and display flags.
(() => {
  'use strict';

  const CHANNEL = 'x-account-location-flags';
  const CACHE_KEY = 'locations';
  const CACHE_AGE = 7 * 24 * 60 * 60 * 1000;
  const REQUEST_GAP = 2000;
  const cache = new Map();
  const queued = new Set();
  const queue = [];
  const waiting = new Map();
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const countryCodes = new Map([
    ['united states of america', 'US'], ['usa', 'US'], ['uk', 'GB'],
    ['russia', 'RU'], ['south korea', 'KR'], ['north korea', 'KP'],
    ['korea', 'KR'], ['turkey', 'TR'], ['czech republic', 'CZ'],
    ['taiwan', 'TW'], ['hong kong', 'HK'], ['europe', 'EU']
  ]);
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      countryCodes.set(regionNames.of(code).toLowerCase(), code);
    }
  }
  let ready = false;
  let running = false;
  let retryAt = 0;
  let nextRequestAt = 0;
  let sequence = 0;
  let scanTimer = null;

  function flagFor(country) {
    if (!country || typeof country !== 'string') return null;
    const code = countryCodes.get(country.trim().toLowerCase());
    return code ? String.fromCodePoint(...[...code].map(letter => 127397 + letter.charCodeAt(0))) : null;
  }

  function findHandles() {
    const handles = [];
    for (const container of document.querySelectorAll('[data-testid="User-Name"], [data-testid="UserName"]')) {
      for (const link of container.querySelectorAll('a[href]')) {
        const raw = link.getAttribute('href') || '';
        const match = /^\/([a-zA-Z0-9_]{1,15})(?:\/?(?:\?.*)?)?$/.exec(raw);
        if (!match) continue;
        const badge = link.querySelector('[data-x-account-flag]');
        const text = link.textContent.replace(badge?.textContent || '', '').trim();
        if (text.toLowerCase() !== '@' + match[1].toLowerCase()) continue;
        handles.push({ link, username: match[1].toLowerCase() });
      }
    }
    return handles;
  }

  function paint() {
    for (const { link, username } of findHandles()) {
      const entry = cache.get(username);
      let badge = link.querySelector('[data-x-account-flag]');
      const flag = entry && entry.expires > Date.now() ? flagFor(entry.country) : null;
      if (flag) {
        if (!badge) {
          badge = document.createElement('span');
          badge.dataset.xAccountFlag = 'true';
          badge.style.marginInlineStart = '0.3em';
          link.append(badge);
        }
        if (badge.textContent !== flag) badge.textContent = flag;
        badge.title = `Account based in ${entry.country}`;
      } else if (badge) {
        badge.remove();
      }
      if (!entry || entry.expires <= Date.now()) enqueue(username);
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      paint();
    }, 200);
  }

  function enqueue(username) {
    if (queued.has(username)) return;
    queued.add(username);
    queue.push(username);
    void processQueue();
  }

  function lookup(username) {
    const id = ++sequence;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        waiting.delete(id);
        resolve({ success: false });
      }, 12000);
      waiting.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
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
        if (result.retryAt) {
          retryAt = result.retryAt;
          queue.unshift(username);
        } else {
          queued.delete(username);
          if (!result.success) {
            // Avoid hammering the API when authentication or connectivity fails.
            cache.set(username, { country: null, expires: Date.now() + 5 * 60 * 1000 });
          } else {
            cache.set(username, { country: result.country, expires: Date.now() + CACHE_AGE });
            // Only successful results are cached; no credentials are stored.
            void browser.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) }).catch(() => {});
            scheduleScan();
          }
        }
      }
    } finally {
      running = false;
    }
  }

  window.addEventListener('message', (event) => {
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
        if (/^[a-z0-9_]{1,15}$/.test(name) && entry?.expires > Date.now()) {
          cache.set(name, entry);
        }
      }
    } catch (_) {
      // Browsing still works if storage is temporarily unavailable.
    }
    paint();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    window.postMessage({ channel: CHANNEL, type: 'hello' }, location.origin);
  }
  void start();
})();
