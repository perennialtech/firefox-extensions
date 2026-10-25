// ISOLATED world: detect account handles, pace lookups and display cached flags.
(() => {
  'use strict';

  const CHANNEL = 'x-account-location-flags';
  const CACHE_KEY = 'locations';
  const CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
  const EMPTY_CACHE_AGE = 6 * 60 * 60 * 1000;
  const ERROR_CACHE_AGE = 2 * 60 * 1000;
  // Keep background requests paced, but prioritize a user under the pointer.
  const REQUEST_GAP = 3000;
  const FOCUSED_REQUEST_GAP = 750;
  const MAX_QUEUE = 200;
  const USER_SELECTOR = '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"]';
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
  let lastRequestAt = 0;
  let focusedUsername = null;
  let wakeQueue = null;

  function flagFor(country) {
    if (typeof country !== 'string') return null;
    const trimmed = country.trim().toLowerCase();
    const code = countryCodes.get(trimmed) ||
      (/^[a-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : null);
    if (!code || !/^[A-Z]{2}$/.test(code)) return null;
    return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
  }

  function findHandles(root = document) {
    const matches = [];
    const containers = root.matches?.(USER_SELECTOR)
      ? [root] : root.querySelectorAll(USER_SELECTOR);
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

  function isVisible(link) {
    if (typeof link.getBoundingClientRect !== 'function') return true;
    const rect = link.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight;
    const width = window.innerWidth || document.documentElement.clientWidth;
    return rect.bottom > 0 && rect.top < height &&
      rect.right > 0 && rect.left < width;
  }

  function enqueue(username) {
    if (cache.get(username)?.expires > Date.now()) return;
    if (queued.has(username) || queue.length >= MAX_QUEUE) return;
    queued.add(username);
    queue.push(username);
    void processQueue();
  }

  function paint() {
    const now = Date.now();
    const visible = new Set();
    for (const { link, username } of findHandles()) {
      if (isVisible(link)) visible.add(username);
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
      if (!current && visible.has(username)) enqueue(username);
    }
    // Scrolling past a row must not leave its queued lookup ahead of the
    // account currently being viewed.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!visible.has(queue[i])) {
        queued.delete(queue[i]);
        queue.splice(i, 1);
      }
    }
    if (focusedUsername && !visible.has(focusedUsername)) focusedUsername = null;
    wakeQueue?.();
  }

  // A hover or keyboard focus promotes its author without making every DOM
  // mutation an extra request. The active author takes the next available slot.
  function prioritize(event) {
    const container = event.target?.closest?.(
      USER_SELECTOR + ', article[data-testid="tweet"]'
    );
    const match = container && findHandles(container).find(({ link }) => isVisible(link));
    const next = match?.username || null;
    if (next === focusedUsername) return;
    focusedUsername = next;
    if (next) enqueue(next);
    wakeQueue?.();
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

  function sleepOrWake(delay) {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (wakeQueue === wake) wakeQueue = null;
        resolve();
      }, delay);
      function wake() {
        clearTimeout(timeout);
        if (wakeQueue === wake) wakeQueue = null;
        resolve();
      }
      wakeQueue = wake;
    });
  }

  async function processQueue() {
    if (!ready || running) return;
    running = true;
    try {
      while (ready && queue.length) {
        const urgent = focusedUsername && queue.includes(focusedUsername);
        const delay = Math.max(0, retryAt - Date.now(),
          (urgent ? lastRequestAt + FOCUSED_REQUEST_GAP : nextRequestAt) - Date.now());
        if (delay) {
          await sleepOrWake(delay);
          continue; // The hovered item or visible queue may have changed.
        }
        const index = urgent ? queue.indexOf(focusedUsername) : 0;
        const [username] = queue.splice(index, 1);
        lastRequestAt = Date.now();
        nextRequestAt = lastRequestAt + REQUEST_GAP;
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
    document.addEventListener('pointerover', prioritize, true);
    document.addEventListener('focusin', prioritize, true);
    // Capture scrolling in nested timelines too; mutation events alone do not
    // fire when an existing account simply moves into the viewport.
    window.addEventListener('scroll', scheduleScan, true);
    window.addEventListener('resize', scheduleScan);
    paint();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true
    });
    window.postMessage({ channel: CHANNEL, type: 'hello' }, location.origin);
  }
  void start();
})();
