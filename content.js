// Annotate handles in the X interface. Network requests run only in background.js.
(() => {
  'use strict';

  const USER_SELECTOR = '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"]';
  const MAX_IN_FLIGHT = 4;
  const MAX_QUEUE = 150;
  const entries = new Map();
  const queued = new Set();
  const urgent = new Set();
  const inFlight = new Set();
  const queue = [];
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const codes = new Map([
    ['united states of america', 'US'], ['usa', 'US'], ['uk', 'GB'],
    ['russia', 'RU'], ['south korea', 'KR'], ['north korea', 'KP'],
    ['korea', 'KR'], ['turkey', 'TR'], ['czech republic', 'CZ'],
    ['taiwan', 'TW'], ['hong kong', 'HK']
  ]);
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = regionNames.of(code);
      if (name !== code) codes.set(name.toLowerCase(), code);
    }
  }

  let scanTimer = null;
  let retryTimer = null;
  let retryAt = 0;

  function flagFor(country) {
    if (typeof country !== 'string') return null;
    const value = country.trim().toLowerCase();
    const code = codes.get(value) || (/^[a-z]{2}$/.test(value) ? value.toUpperCase() : null);
    if (!code || !/^[A-Z]{2}$/.test(code)) return null;
    return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
  }

  function findHandles(root = document) {
    const containers = [];
    if (root.matches?.(USER_SELECTOR)) containers.push(root);
    containers.push(...root.querySelectorAll(USER_SELECTOR));
    const handles = [];
    for (const container of containers) {
      for (const link of container.querySelectorAll('a[href]')) {
        let pathname;
        try {
          const url = new URL(link.getAttribute('href'), location.href);
          if (url.origin !== location.origin) continue;
          pathname = url.pathname;
        } catch (_) { continue; }
        const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(pathname);
        if (!match) continue;
        if (link.textContent.trim().toLowerCase() !== '@' + match[1].toLowerCase()) continue;
        handles.push({ link, username: match[1].toLowerCase() });
      }
    }
    return handles;
  }

  function visible(link) {
    const rect = link.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight;
    const width = window.innerWidth || document.documentElement.clientWidth;
    return rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width;
  }

  function paint(link, entry) {
    // X's handle <a> contains a flex column. Appending a badge *inside* it
    // creates an unwanted second line. Instead put it beside the handle's
    // wrapper, as a sibling of X's dot separator and timestamp.
    const slot = link.parentElement;
    const row = slot?.parentElement;
    if (!row) return;
    const existing = [...row.children].filter(child => child.dataset?.xAccountFlag === 'true');
    const location = typeof entry?.country === 'string' ? entry.country.trim() : '';
    const flag = flagFor(location);
    const display = flag || location;
    if (!display) {
      for (const badge of existing) badge.remove();
      return;
    }
    // React may recycle a row for a different account. Reuse only the badge
    // associated with the current handle, not with the former occupant.
    const username = link.getAttribute('href')?.replace(/^\//, '').toLowerCase();
    let badge = existing.find(child => child.dataset.xAccountHandle === username);
    for (const old of existing) if (old !== badge) old.remove();
    if (!badge) {
      badge = document.createElement('span');
      badge.dataset.xAccountFlag = 'true';
      badge.dataset.xAccountHandle = username;
    }
    // Keep the badge in the native horizontal flex row, immediately after the
    // handle slot and before the separator/date, even after X reorders nodes.
    if (badge.parentElement !== row || badge.previousElementSibling !== slot) {
      row.insertBefore(badge, slot.nextSibling);
    }
    if (badge.textContent !== display) badge.textContent = display;
    const label = 'Account based in ' + location + ' (according to X)' +
      (entry.accurate === false ? '; X marks this location as uncertain' : '');
    badge.title = label;
    badge.setAttribute('aria-label', label);
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.alignSelf = 'center';
    badge.style.marginInlineStart = '0.35em';
    badge.style.flexShrink = flag ? '0' : '1';
    badge.style.minWidth = '0';
    badge.style.whiteSpace = 'nowrap';
    badge.style.lineHeight = '1';
    badge.style.verticalAlign = 'middle';
    badge.style.fontSize = flag ? '1em' : '0.85em';
    badge.style.color = flag ? 'inherit' : 'rgb(113, 118, 123)';
    badge.style.maxWidth = flag ? '' : '11em';
    badge.style.overflow = flag ? '' : 'hidden';
    badge.style.textOverflow = flag ? '' : 'ellipsis';
  }

  function enqueue(username, priority = false) {
    const current = entries.get(username);
    if (current?.expires > Date.now() || inFlight.has(username)) return;
    if (priority) urgent.add(username);
    if (queued.has(username)) {
      if (priority) {
        const index = queue.indexOf(username);
        if (index > 0) queue.unshift(...queue.splice(index, 1));
      }
    } else if (queue.length < MAX_QUEUE) {
      queued.add(username);
      if (priority) queue.unshift(username);
      else queue.push(username);
    }
    pump();
  }

  function delayRetry(until) {
    retryAt = Math.max(retryAt, until);
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryAt = 0;
      scan();
    }, Math.max(1, retryAt - Date.now()));
  }

  function pump() {
    if (Date.now() < retryAt) return;
    while (inFlight.size < MAX_IN_FLIGHT && queue.length) {
      const username = queue.shift();
      queued.delete(username);
      if (entries.get(username)?.expires > Date.now()) continue;
      inFlight.add(username);
      const priority = urgent.delete(username);
      void browser.runtime.sendMessage({ type: 'lookup', username, priority })
        .then(result => {
          if (result?.success) {
            entries.set(username, { country: result.country, accurate: result.accurate,
              expires: Date.now() + 30 * 60 * 1000 });
            // Includes DOM nodes which were recycled while the lookup ran.
            for (const item of findHandles()) {
              if (item.username === username) paint(item.link, entries.get(username));
            }
          } else if (result?.retryAt > Date.now()) {
            delayRetry(result.retryAt);
          } else {
            // Transient API failures should not become a permanent "no location".
            entries.set(username, { country: null, expires: Date.now() + 30000 });
          }
        }).catch(() => {
          entries.set(username, { country: null, expires: Date.now() + 30000 });
        }).finally(() => {
          inFlight.delete(username);
          pump();
        });
    }
  }

  function scan() {
    const visibleNames = new Set();
    for (const { link, username } of findHandles()) {
      const current = entries.get(username);
      // Clear badges on recycled X rows as well as updating cached locations.
      paint(link, current?.expires > Date.now() ? current : null);
      if (visible(link)) {
        visibleNames.add(username);
        if (!current || current.expires <= Date.now()) enqueue(username);
      }
    }
    // Do not prefetch accounts that have since scrolled away.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!visibleNames.has(queue[i])) {
        queued.delete(queue[i]);
        urgent.delete(queue[i]);
        queue.splice(i, 1);
      }
    }
    pump();
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 80);
  }

  function prioritize(event) {
    const target = event.target?.closest?.(USER_SELECTOR + ', article[data-testid="tweet"]');
    if (!target) return;
    const match = findHandles(target).find(({ link }) => visible(link));
    if (match) enqueue(match.username, true);
  }

  document.addEventListener('pointerover', prioritize, true);
  document.addEventListener('focusin', prioritize, true);
  window.addEventListener('scroll', scheduleScan, true);
  window.addEventListener('resize', scheduleScan);
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true, subtree: true
  });
  scan();
})();
