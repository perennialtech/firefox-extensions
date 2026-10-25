// MAIN world: capture only headers from X's own requests; never expose tokens.
(() => {
  'use strict';

  const CHANNEL = 'x-account-location-flags';
  const ABOUT = 'AboutAccountQuery';
  // Both IDs are used by maintained extensions. Native X requests take precedence.
  const FALLBACK_IDS = ['XRqGa7EeokUU5kppkh13EA', 'zs_jFPFT78rBpXv9Z3U2YQ'];
  const ID_PATTERN = /^[a-zA-Z0-9_-]{5,64}$/;
  const HANDLE_PATTERN = /^[a-zA-Z0-9_]{1,15}$/;
  const originalFetch = window.fetch;
  let headers = null;
  let queryId = FALLBACK_IDS[0];

  function publish(data) {
    window.postMessage({ channel: CHANNEL, ...data }, location.origin);
  }

  function inspect(url, inputHeaders) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin ||
          !parsed.pathname.startsWith('/i/api/graphql/')) return;

      const match = /^\/i\/api\/graphql\/([^/]+)\/AboutAccountQuery$/.exec(parsed.pathname);
      if (match && ID_PATTERN.test(match[1])) queryId = match[1];

      const candidate = new Headers(inputHeaders);
      if (!candidate.has('authorization')) return;
      const next = {};
      for (const name of ['authorization', 'x-twitter-active-user',
        'x-twitter-auth-type', 'x-twitter-client-language']) {
        if (candidate.has(name)) next[name] = candidate.get(name);
      }
      if (headers?.authorization !== next.authorization) {
        headers = next;
        publish({ type: 'ready' });
      } else {
        headers = next;
      }
    } catch (_) {
      // Interception must never disrupt X's own requests.
    }
  }

  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' || input instanceof URL
        ? String(input) : input?.url;
      const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
      if (url) inspect(url, requestHeaders);
    } catch (_) {}
    return originalFetch.apply(this, arguments);
  };

  // X can use XMLHttpRequest instead of fetch, including for the first API call.
  if (typeof XMLHttpRequest !== 'undefined') {
    const requests = new WeakMap();
    const proto = XMLHttpRequest.prototype;
    const open = proto.open;
    const setRequestHeader = proto.setRequestHeader;
    const send = proto.send;
    proto.open = function (method, url) {
      requests.set(this, { url: String(url), headers: new Headers() });
      return open.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      requests.get(this)?.headers.set(name, value);
      return setRequestHeader.apply(this, arguments);
    };
    proto.send = function () {
      const request = requests.get(this);
      if (request) inspect(request.url, request.headers);
      return send.apply(this, arguments);
    };
  }

  function csrfFromCookie() {
    const match = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie || '');
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
  }

  function untilReset(response) {
    const reset = Number(response.headers?.get('x-rate-limit-reset'));
    return Number.isFinite(reset) && reset * 1000 > Date.now()
      ? reset * 1000 + 3000 : Date.now() + 15 * 60 * 1000;
  }

  async function request(username, id) {
    const url = new URL('/i/api/graphql/' + id + '/' + ABOUT, location.origin);
    url.searchParams.set('variables', JSON.stringify({ screenName: username }));
    const requestHeaders = {
      ...headers,
      'x-twitter-active-user': headers['x-twitter-active-user'] || 'yes',
      'x-twitter-auth-type': headers['x-twitter-auth-type'] || 'OAuth2Session',
      accept: '*/*'
    };
    const csrf = csrfFromCookie();
    if (csrf) requestHeaders['x-csrf-token'] = csrf;
    const response = await originalFetch.call(window, url.toString(), {
      method: 'GET', credentials: 'include', headers: requestHeaders
    });
    return response;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== CHANNEL) return;
    if (event.data.type === 'hello') {
      if (headers) publish({ type: 'ready' });
      return;
    }
    if (event.data.type !== 'lookup') return;
    const { id, username } = event.data;
    if (!Number.isSafeInteger(id) || !HANDLE_PATTERN.test(username) || !headers) return;

    let success = false;
    let country = null;
    let retryAt = 0;
    let status = 0;
    try {
      // Retry only a missing operation, never an auth failure or a rate limit.
      const ids = [queryId, ...FALLBACK_IDS.filter(value => value !== queryId)];
      for (const candidate of ids) {
        const response = await request(username, candidate);
        status = response.status;
        if (status === 404 && candidate !== ids[ids.length - 1]) continue;
        if (status === 429) {
          retryAt = untilReset(response);
        } else if (response.ok) {
          const body = await response.json();
          const result = body?.data?.user_result_by_screen_name?.result;
          if (result && typeof result === 'object' && !body.errors) {
            const value = result.about_profile?.account_based_in;
            country = typeof value === 'string' ? value : null;
            success = true;
            queryId = candidate;
          }
          // Treat a depleted X bucket as a pause even when the last call worked.
          if (Number(response.headers?.get('x-rate-limit-remaining')) === 0 &&
              response.headers?.get('x-rate-limit-remaining') !== null) {
            retryAt = untilReset(response);
          }
        }
        break;
      }
    } catch (_) {
      // A failed lookup must not crash X or poison the persistent cache.
    }
    publish({ type: 'result', id, country, success, retryAt, status });
  });
})();
