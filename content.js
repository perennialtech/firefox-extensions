// Annotate handles in the X interface. Network requests run only in background.js.
(() => {
  'use strict';

  const USER_SELECTOR = '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"]';
  const MAX_IN_FLIGHT = 4;
  const MAX_QUEUE = 150;
  // Reserve one consistent footprint for flags, region names and empty results.
  // Without it, the timestamp moves horizontally after every API response.
  const LOCATION_WIDTH = '5.5rem';
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
    const found = [];
    const seen = new Set();
    for (const container of containers) {
      // UserCell also contains bio links. Only decorate the account header,
      // identified by a display-name link AND its matching @handle link.
      const links = [...container.querySelectorAll('a[href]')];
      const handles = new Set();
      for (const link of links) {
        if (link.getAttribute('tabindex') !== '-1') continue;
        const value = link.textContent.trim();
        const path = link.getAttribute('href');
        if (!path || !/^@[a-zA-Z0-9_]{1,15}$/.test(value)) continue;
        if (path.toLowerCase() === '/' + value.slice(1).toLowerCase()) {
          handles.add(value.slice(1).toLowerCase());
        }
      }
      for (const link of links) {
        if (link.getAttribute('tabindex') === '-1') continue;
        if (link.getAttribute('role') !== 'link') continue;
        const path = link.getAttribute('href');
        const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(path || '');
        if (!match || !handles.has(match[1].toLowerCase())) continue;
        // The display-name link is distinct from the handle and avatar links.
        if (link.textContent.trim().startsWith('@') || !link.textContent.trim()) continue;
        if (seen.has(link)) continue;
        seen.add(link);
        found.push({ link, username: match[1].toLowerCase(), placement: 'header' });
        break;
      }
      // UserCell biographies can contain @mentions with their own locations.
      // Keep those as inline annotations, but never mistake them for the
      // card's account identity or move them into the display-name row.
      if (container.getAttribute?.('data-testid') === 'UserCell') {
        for (const link of container.querySelectorAll('div[dir="auto"] a[href]')) {
          const path = link.getAttribute('href') || '';
          const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(path);
          if (!match || link.textContent.trim().toLowerCase() !== '@' + match[1].toLowerCase()) continue;
          if (seen.has(link)) continue;
          seen.add(link);
          found.push({ link, username: match[1].toLowerCase(), placement: 'mention' });
        }
      }
    }
    return found;
  }

  function visible(link) {
    const rect = link.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight;
    const width = window.innerWidth || document.documentElement.clientWidth;
    return rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width;
  }

  function paint(link, entry, loading = false, placement = 'header') {
    // Header locations precede display names. Bio mention badges instead sit
    // after their @mention wrapper in the existing inline biography flow.
    const anchor = placement === 'mention' ? link.parentElement : link;
    const row = anchor?.parentElement;
    if (!row) return;
    const username = link.getAttribute('href')?.replace(/^\//, '').toLowerCase();
    const existing = [...row.children].filter(child => child.dataset?.xAccountFlag === 'true');
    let badge = existing.find(child => child.dataset.xAccountHandle === username);
    for (const old of existing) if (old !== badge) old.remove();
    if (!badge) {
      badge = document.createElement('span');
      badge.dataset.xAccountFlag = 'true';
      badge.dataset.xAccountHandle = username;
      badge.style.display = 'inline-block';
      badge.style.boxSizing = 'border-box';
      badge.style.width = LOCATION_WIDTH;
      badge.style.flex = '0 0 ' + LOCATION_WIDTH;
      badge.style.minWidth = LOCATION_WIDTH;
      badge.style.maxWidth = LOCATION_WIDTH;
      badge.style.marginInlineEnd = placement === 'header' ? '0.35rem' : '0';
      badge.style.marginInlineStart = placement === 'mention' ? '0.35rem' : '0';
      badge.style.whiteSpace = 'nowrap';
      badge.style.overflow = 'hidden';
      badge.style.textOverflow = 'ellipsis';
      badge.style.alignSelf = 'center';
      badge.style.verticalAlign = 'middle';
      badge.style.lineHeight = '1.25rem';
      badge.style.height = '1.25rem';
    }
    if (placement === 'header') {
      // X's inner display-name wrapper defaults to a flex column.
      // Preserve React's anchor but lay its siblings out horizontally.
      row.style.flexDirection = 'row';
      row.style.alignItems = 'center';
    }
    const next = placement === 'header' ? anchor : anchor.nextSibling;
    if (badge.parentElement !== row ||
        (placement === 'header' ? badge.nextElementSibling !== anchor :
          badge.previousElementSibling !== anchor)) {
      row.insertBefore(badge, next);
    }

    const location = typeof entry?.country === 'string' ? entry.country.trim() : '';
    const flag = flagFor(location);
    const display = flag || location;
    if (badge.textContent !== display) badge.textContent = display;
    const isRegion = !!display && !flag;
    badge.style.fontSize = isRegion ? '0.75rem' : '1rem';
    badge.style.paddingInline = isRegion ? '0.35rem' : '0';
    badge.style.backgroundColor = isRegion ? '#f5f5f5' : 'transparent';
    badge.style.color = isRegion ? '#171717' : 'inherit';
    badge.style.borderRadius = '0';

    const pending = loading && !display;
    badge.style.backgroundImage = pending
      ? 'linear-gradient(rgba(113, 118, 123, 0.25), rgba(113, 118, 123, 0.25))'
      : 'none';
    badge.style.backgroundSize = '3.25rem 0.55rem';
    badge.style.backgroundPosition = 'left center';
    badge.style.backgroundRepeat = 'no-repeat';
    if (pending) {
      badge.title = 'Loading account location';
      badge.setAttribute('aria-label', 'Loading account location');
    } else if (display) {
      const label = 'Account based in ' + location + ' (according to X)' +
        (entry.accurate === false ? '; X marks this location as uncertain' : '');
      badge.title = label;
      badge.setAttribute('aria-label', label);
    } else {
      badge.removeAttribute('title');
      badge.removeAttribute('aria-label');
    }
  }

  function paintUsername(username) {
    const current = entries.get(username);
    const valid = current?.expires > Date.now() ? current : null;
    const loading = !valid && Date.now() >= retryAt;
    for (const item of findHandles()) {
      if (item.username === username) paint(item.link, valid, loading, item.placement);
    }
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
            // The fixed slot is already present; only its contents change.
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
          paintUsername(username);
          pump();
        });
    }
  }

  function scan() {
    const visibleNames = new Set();
    for (const { link, username, placement } of findHandles()) {
      const current = entries.get(username);
      // Create the fixed-width loading slot before any network lookup starts.
      // A completed empty result keeps the slot but clears the skeleton.
      const valid = current?.expires > Date.now() ? current : null;
      paint(link, valid, !valid && Date.now() >= retryAt, placement);
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
