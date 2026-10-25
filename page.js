// MAIN world: reuse the authentication headers that X sends itself.
// Never send the headers to the extension's isolated content script.
(() => {
  'use strict';

  const CHANNEL = 'x-account-location-flags';
  const API_PATH = '/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery';
  const originalFetch = window.fetch;
  let authHeaders = null;

  window.fetch = function (...args) {
    try {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input?.url;
      if (url && new URL(url, location.href).origin === location.origin &&
          new URL(url, location.href).pathname.startsWith('/i/api/graphql/')) {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        if (headers.has('authorization') && headers.has('x-csrf-token')) {
          authHeaders = {};
          for (const key of ['authorization', 'x-csrf-token', 'x-twitter-active-user',
            'x-twitter-auth-type', 'x-twitter-client-language']) {
            if (headers.has(key)) authHeaders[key] = headers.get(key);
          }
          window.postMessage({ channel: CHANNEL, type: 'ready' }, location.origin);
        }
      }
    } catch (_) {
      // Header inspection must never break X's own network requests.
    }
    return originalFetch.apply(this, args);
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== CHANNEL) return;

    if (event.data.type === 'hello') {
      if (authHeaders) window.postMessage({ channel: CHANNEL, type: 'ready' }, location.origin);
      return;
    }
    if (event.data.type !== 'lookup') return;

    const { id, username } = event.data;
    if (!Number.isSafeInteger(id) || !/^[a-zA-Z0-9_]{1,15}$/.test(username) || !authHeaders) return;

    let country = null;
    let retryAt = 0;
    let success = false;
    try {
      const url = new URL(API_PATH, location.origin);
      url.searchParams.set('variables', JSON.stringify({ screenName: username }));
      // Call the unwrapped fetch, to avoid intercepting our own API requests.
      const response = await originalFetch.call(window, url.toString(), {
        credentials: 'include',
        headers: authHeaders
      });
      if (response.status === 429) {
        const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
        retryAt = Number.isFinite(reset) && reset > Date.now()
          ? reset : Date.now() + 15 * 60 * 1000;
      } else if (response.ok) {
        const data = await response.json();
        country = data?.data?.user_result_by_screen_name?.result?.about_profile?.account_based_in;
        country = typeof country === 'string' ? country : null;
        success = true;
      }
    } catch (_) {
      // Network failures are retried on a later page load.
    }
    window.postMessage({ channel: CHANNEL, type: 'result', id, country, retryAt, success }, location.origin);
  });
})();
