// Annotate handles in the X interface. Network requests run only in background.js.
(() => {
  'use strict';

  const USER_SELECTOR = '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"]';
  const MAX_IN_FLIGHT = 4;
  const MAX_QUEUE = 150;
  // Reserve one consistent footprint for location chips and empty results.
  // Without it, the timestamp moves horizontally after every API response.
  const LOCATION_WIDTH = '5.5rem';
  const entries = new Map();
  const queued = new Set();
  const urgent = new Set();
  const inFlight = new Set();
  const queue = [];
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  // ISO 3166-1 alpha-2 -> alpha-3 (iso-codes project). Limit country
  // lookups to assigned ISO codes: CLDR also names non-country regions.
  const countryCodes = new Map(([
    'ADAND AEARE AFAFG AGATG AIAIA ALALB AMARM AOAGO AQATA ARARG ASASM ATAUT AUAUS AWABW',
    'AXALA AZAZE BABIH BBBRB BDBGD BEBEL BFBFA BGBGR BHBHR BIBDI BJBEN BLBLM BMBMU BNBRN',
    'BOBOL BQBES BRBRA BSBHS BTBTN BVBVT BWBWA BYBLR BZBLZ CACAN CCCCK CDCOD CFCAF CGCOG',
    'CHCHE CICIV CKCOK CLCHL CMCMR CNCHN COCOL CRCRI CUCUB CVCPV CWCUW CXCXR CYCYP CZCZE',
    'DEDEU DJDJI DKDNK DMDMA DODOM DZDZA ECECU EEEST EGEGY EHESH ERERI ESESP ETETH FIFIN',
    'FJFJI FKFLK FMFSM FOFRO FRFRA GAGAB GBGBR GDGRD GEGEO GFGUF GGGGY GHGHA GIGIB GLGRL',
    'GMGMB GNGIN GPGLP GQGNQ GRGRC GSSGS GTGTM GUGUM GWGNB GYGUY HKHKG HMHMD HNHND HRHRV',
    'HTHTI HUHUN IDIDN IEIRL ILISR IMIMN ININD IOIOT IQIRQ IRIRN ISISL ITITA JEJEY JMJAM',
    'JOJOR JPJPN KEKEN KGKGZ KHKHM KIKIR KMCOM KNKNA KPPRK KRKOR KWKWT KYCYM KZKAZ LALAO',
    'LBLBN LCLCA LILIE LKLKA LRLBR LSLSO LTLTU LULUX LVLVA LYLBY MAMAR MCMCO MDMDA MEMNE',
    'MFMAF MGMDG MHMHL MKMKD MLMLI MMMMR MNMNG MOMAC MPMNP MQMTQ MRMRT MSMSR MTMLT MUMUS',
    'MVMDV MWMWI MXMEX MYMYS MZMOZ NANAM NCNCL NENER NFNFK NGNGA NINIC NLNLD NONOR NPNPL',
    'NRNRU NUNIU NZNZL OMOMN PAPAN PEPER PFPYF PGPNG PHPHL PKPAK PLPOL PMSPM PNPCN PRPRI',
    'PSPSE PTPRT PWPLW PYPRY QAQAT REREU ROROU RSSRB RURUS RWRWA SASAU SBSLB SCSYC SDSDN',
    'SESWE SGSGP SHSHN SISVN SJSJM SKSVK SLSLE SMSMR SNSEN SOSOM SRSUR SSSSD STSTP SVSLV',
    'SXSXM SYSYR SZSWZ TCTCA TDTCD TFATF TGTGO THTHA TJTJK TKTKL TLTLS TMTKM TNTUN TOTON',
    'TRTUR TTTTO TVTUV TWTWN TZTZA UAUKR UGUGA UMUMI USUSA UYURY UZUZB VAVAT VCVCT VEVEN',
    'VGVGB VIVIR VNVNM VUVUT WFWLF WSWSM YEYEM YTMYT ZAZAF ZMZMB ZWZWE'
  ].join(' ').split(' ')).map(item => [item.slice(0, 2), item.slice(2)]));
  const countries = new Map();
  for (const [code, alpha3] of countryCodes) {
    countries.set(code.toLowerCase(), code);
    countries.set(alpha3.toLowerCase(), code);
    countries.set(regionNames.of(code).toLowerCase(), code);
  }
  // Common FxTwitter labels that differ from CLDR English country names.
  for (const [name, code] of Object.entries({
    'united states of america': 'US', 'uk': 'GB', 'korea': 'KR',
    'south korea': 'KR', 'north korea': 'KP', 'republic of korea': 'KR',
    'czech republic': 'CZ', 'turkey': 'TR', 'ivory coast': 'CI',
    'democratic republic of the congo': 'CD', 'dr congo': 'CD',
    'republic of the congo': 'CG', 'vatican city': 'VA',
    'palestine': 'PS', 'hong kong': 'HK', 'macao': 'MO', 'macau': 'MO'
  })) countries.set(name, code);

  // CLDR territory-containment region identifiers (including groupings).
  // Intl.DisplayNames provides the CLDR English names, not a second
  // manually maintained region-name table.
  const regionCodes = new Map();
  for (const code of ('001 002 003 005 009 011 013 014 015 017 018 019 ' +
    '021 029 030 034 035 039 053 054 057 061 142 143 145 150 ' +
    '151 154 155 202 419 EU EZ QO UN').split(' ')) {
    const name = regionNames.of(code);
    if (name !== code) regionCodes.set(name.toLowerCase(), code);
    regionCodes.set(code.toLowerCase(), code);
  }
  // Common region spellings from X differ from CLDR's formal names.
  for (const [name, code] of Object.entries({
    'east asia': '030', 'southeast asia': '035', 'south east asia': '035',
    'south-eastern asia': '035',
    'south asia': '034', 'west asia': '145', 'central asia': '143',
    'north america': '021', 'south america': '005',
    'east africa': '014', 'west africa': '011', 'north africa': '015',
    'central africa': '017',
    'north europe': '154', 'south europe': '039',
    'east europe': '151', 'west europe': '155',
    'latin america and the caribbean': '419'
  })) regionCodes.set(name, code);
  // Only presentation abbreviations are curated; identification uses CLDR.
  const regionAbbreviations = {
    '005': 'S America', '011': 'W Africa', '013': 'C America',
    '014': 'E Africa', '015': 'N Africa', '017': 'C Africa',
    '018': 'S Africa', '021': 'N America', '030': 'E Asia',
    '034': 'S Asia', '035': 'SE Asia', '039': 'S Europe',
    '143': 'C Asia', '145': 'W Asia', '151': 'E Europe',
    '154': 'N Europe', '155': 'W Europe', '202': 'SSA',
    '419': 'LATAM'
  };
  const otherAbbreviations = { 'middle east': 'M East', 'central europe': 'C Europe' };

  let scanTimer = null;
  let retryTimer = null;
  let retryAt = 0;

  function locationLabel(location) {
    if (!location) return '';
    const key = location.toLowerCase();
    const code = countries.get(key);
    if (code) {
      const flag = String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
      return flag + ' ' + countryCodes.get(code);
    }
    const region = regionCodes.get(key);
    if (region) return regionAbbreviations[region] || regionNames.of(region);
    return otherAbbreviations[key] || location;
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
    const display = locationLabel(location);
    if (badge.textContent !== display) badge.textContent = display;
    badge.style.fontSize = '0.75rem';
    badge.style.paddingInline = display ? '0.35rem' : '0';
    badge.style.backgroundColor = display ? '#f5f5f5' : 'transparent';
    badge.style.color = display ? '#171717' : 'inherit';
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
