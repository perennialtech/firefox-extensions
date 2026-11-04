// Look up X's "Account based in" metadata using FxTwitter, never X credentials.
(() => {
  'use strict';

  const API_ORIGIN = 'https://api.fxtwitter.com';
  const STORAGE_KEY = 'fxtwitter-locations-v1';
  const RATE_LIMIT_KEY = 'fxtwitter-rate-limit-until-v1';
  const POSITIVE_TTL = 14 * 24 * 60 * 60 * 1000;
  const EMPTY_TTL = 12 * 60 * 60 * 1000;
  const RETRY_MS = 60 * 1000;
  const MAX_CACHE_SIZE = 3000;
  const MAX_ACTIVE = 4;
  const REQUEST_INTERVAL = 200;
  const HANDLE = /^[a-zA-Z0-9_]{1,15}$/;
  const USER_ID = /^[0-9]+$/;

  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let loaded;
  let active = 0;
  let nextRequestAt = 0;
  let blockedUntil = 0;
  let pumpTimer = null;
  let saveTimer = null;

  function loadCache() {
    if (!loaded) {
      loaded = browser.storage.local.get([STORAGE_KEY, RATE_LIMIT_KEY]).then(stored => {
        const now = Date.now();
        const paused = Number(stored[RATE_LIMIT_KEY]);
        if (Number.isFinite(paused) && paused > now) blockedUntil = paused;
        for (const [handle, value] of Object.entries(stored[STORAGE_KEY] || {})) {
          if ((HANDLE.test(handle) || (handle.startsWith('id:') && USER_ID.test(handle.slice(3)))) &&
              value &&
              value.expires > now &&
              (value.country === null || typeof value.country === 'string') &&
              (value.accurate === null || typeof value.accurate === 'boolean') &&
              (value.createdCountryAccurate == null || typeof value.createdCountryAccurate === 'boolean') &&
              (value.source == null || typeof value.source === 'string')) {
            cache.set(handle, value);
          }
        }
      }).catch(() => {});
    }
    return loaded;
  }

  function saveSoon() {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const now = Date.now();
      for (const [key, value] of cache) {
        if (value.expires <= now) cache.delete(key);
      }
      while (cache.size > MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
      void browser.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(cache) })
        .catch(() => {});
    }, 300);
  }

  function backoff(response) {
    const retry = response.headers.get('retry-after');
    const seconds = Number(retry);
    const duration = Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000 : Date.parse(retry) - Date.now();
    return Date.now() + (Number.isFinite(duration) && duration > 0 ? duration : RETRY_MS);
  }

  function failPendingOnRateLimit() {
    const queued = queue.splice(0);
    for (const task of queued) task.resolve({ success: false, retryAt: blockedUntil });
  }

  async function request(handle) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(API_ORIGIN + '/2/profile/' + handle + '/about', {
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      let body = null;
      if (response.ok) {
        try { body = await response.json(); } catch (_) {}
      }
      if (response.status === 429 || body?.code === 429) {
        blockedUntil = Math.max(blockedUntil, backoff(response));
        void browser.storage.local.set({ [RATE_LIMIT_KEY]: blockedUntil }).catch(() => {});
        failPendingOnRateLimit();
        return { success: false, retryAt: blockedUntil };
      }
      // FxTwitter can report an API error in an HTTP 200 JSON envelope.
      if (!response.ok || !body || body.code !== 200) return { success: false };
      const { based_in, location_accurate, created_country_accurate, source } = body.about_account || {};
      const country = typeof based_in === 'string' && based_in.length <= 100
        ? based_in.trim() || null : null;
      const metadata = {
        country,
        accurate: typeof location_accurate === 'boolean' ? location_accurate : null,
        createdCountryAccurate: typeof created_country_accurate === 'boolean' ? created_country_accurate : null,
        source: typeof source === 'string' ? source.trim() || null : null
      };
      cache.delete(handle);
      cache.set(handle, {
        ...metadata, expires: Date.now() + (country ? POSITIVE_TTL : EMPTY_TTL)
      });
      saveSoon();
      return { success: true, ...metadata };
    } catch (_) {
      return { success: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  function schedulePump(wait) {
    if (pumpTimer !== null) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, wait);
  }

  function pump() {
    if (!queue.length || active >= MAX_ACTIVE) return;
    if (Date.now() < blockedUntil) {
      failPendingOnRateLimit();
      return;
    }
    const delay = nextRequestAt - Date.now();
    if (delay > 0) {
      schedulePump(delay);
      return;
    }
    const task = queue.shift();
    nextRequestAt = Date.now() + REQUEST_INTERVAL;
    active++;
    void request(task.handle).then(task.resolve).finally(() => {
      active--;
      pump();
    });
    if (queue.length) schedulePump(REQUEST_INTERVAL);
  }

  function cachedResult({ country, accurate, createdCountryAccurate = null, source = null }) {
    return { success: true, country, accurate, createdCountryAccurate, source };
  }

  async function lookup(handle, priority) {
    await loadCache();
    const cached = cache.get(handle);
    const unexpired = cached?.expires > Date.now();
    // Legacy cache entries remain usable while the missing fields are refreshed.
    if (unexpired && cached.createdCountryAccurate !== undefined && cached.source !== undefined) {
      return cachedResult(cached);
    }
    if (Date.now() < blockedUntil) {
      return unexpired ? cachedResult(cached) : { success: false, retryAt: blockedUntil };
    }
    if (pending.has(handle)) {
      if (priority) {
        const index = queue.findIndex(item => item.handle === handle);
        if (index > 0) queue.unshift(...queue.splice(index, 1));
      }
      return pending.get(handle);
    }
    const promise = new Promise(resolve => {
      const task = { handle, resolve };
      if (priority) queue.unshift(task);
      else queue.push(task);
      pump();
    });
    const tracked = promise.then(result =>
      !result.success && cached?.expires > Date.now() ? cachedResult(cached) : result
    ).finally(() => pending.delete(handle));
    pending.set(handle, tracked);
    return tracked;
  }

  browser.runtime.onMessage.addListener(message => {
    if (message?.type === 'lookup' && typeof message.username === 'string' &&
        HANDLE.test(message.username)) {
      return lookup(message.username.toLowerCase(), message.priority === true);
    }
    if (message?.type === 'lookup-id' && typeof message.userId === 'string' &&
        USER_ID.test(message.userId)) {
      return lookup('id:' + message.userId, true);
    }
    return undefined;
  });
})();
