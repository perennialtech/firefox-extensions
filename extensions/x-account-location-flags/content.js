// Annotate handles in the X interface. Network requests run only in background.js.
(() => {
  'use strict';

  const USER_SELECTOR = '[data-testid="User-Name"], [data-testid="UserName"], ' +
    '[data-testid="UserCell"], [data-testid="UserDescription"]';
  // X assigns its font to the name elements, not always their parent row.
  // Our sibling chips must not inherit Firefox's default serif font.
  const CHIP_FONT_FAMILY = 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const MAX_IN_FLIGHT = 4;
  const MAX_QUEUE = 150;
  const entries = new Map();
  const queued = new Set();
  const urgent = new Set();
  const inFlight = new Set();
  const queue = [];
  // Header chips temporarily alter the containing name row's inline layout.
  // Track only currently decorated rows so reused or detached rows are restored.
  const headerRowStyles = new Map();
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
  // CLDR's display names often differ from ISO or X's labels. Normalize
  // purely typographic differences once, retaining distinct country/region
  // identifiers and leaving unknown locations untouched.
  function locationKey(value) {
    return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/&/g, ' and ')
      .replace(/\bst\.\s/g, 'saint ')
      .replace(/\s+/g, ' ').trim();
  }

  const countries = new Map();
  for (const [code, alpha3] of countryCodes) {
    countries.set(locationKey(code), code);
    countries.set(locationKey(alpha3), code);
    countries.set(locationKey(regionNames.of(code)), code);
  }
  // ISO 3166-1 English names and common X labels that differ from CLDR.
  // Keep the non-typographic variants explicit: never guess a country for
  // an unknown location or a broader geographical region.
  for (const [name, code] of Object.entries({
    'united states of america': 'US', 'uk': 'GB', 'korea': 'KR',
    'south korea': 'KR', 'north korea': 'KP', 'republic of korea': 'KR',
    'czech republic': 'CZ', 'turkey': 'TR', 'ivory coast': 'CI',
    'democratic republic of the congo': 'CD', 'dr congo': 'CD',
    'republic of the congo': 'CG', 'vatican city': 'VA',
    'palestine': 'PS', 'hong kong': 'HK', 'macao': 'MO', 'macau': 'MO',
    'viet nam': 'VN', 'bosnia and herzegovina': 'BA',
    'bonaire, sint eustatius and saba': 'BQ', 'bonaire': 'BQ',
    'bolivia, plurinational state of': 'BO', 'brunei darussalam': 'BN',
    'congo, the democratic republic of the': 'CD', 'congo': 'CG',
    'cabo verde': 'CV', 'falkland islands (malvinas)': 'FK',
    'micronesia, federated states of': 'FM',
    'heard island and mcdonald islands': 'HM',
    'iran, islamic republic of': 'IR', 'korea, republic of': 'KR',
    "lao people's democratic republic": 'LA',
    'saint martin (french part)': 'MF', 'moldova, republic of': 'MD',
    'myanmar': 'MM', 'pitcairn': 'PN',
    "korea, democratic people's republic of": 'KP',
    'palestine, state of': 'PS', 'russian federation': 'RU',
    'south georgia and the south sandwich islands': 'GS',
    'saint helena, ascension and tristan da cunha': 'SH',
    'sint maarten (dutch part)': 'SX', 'syrian arab republic': 'SY',
    'taiwan, province of china': 'TW',
    'tanzania, united republic of': 'TZ',
    'united states minor outlying islands': 'UM',
    'holy see (vatican city state)': 'VA',
    'saint vincent and the grenadines': 'VC',
    'venezuela, bolivarian republic of': 'VE',
    'virgin islands, british': 'VG', 'virgin islands, u.s.': 'VI',
    // Short and historical labels observed or documented for X locations.
    'macedonia': 'MK', 'east timor': 'TL', 'swaziland': 'SZ',
    'burma': 'MM', 'holy see': 'VA',
    'great britain': 'GB',
    'united kingdom of great britain and northern ireland': 'GB',
    'uae': 'AE', 'republic of moldova': 'MD',
    'federated states of micronesia': 'FM',
    'bosnia': 'BA', 'britain': 'GB', 'svalbard': 'SJ',
    'us virgin islands': 'VI', 'united states virgin islands': 'VI',
    'congo-brazzaville': 'CG', 'congo-kinshasa': 'CD',
    "democratic people's republic of korea": 'KP',
    'micronesia (federated states of)': 'FM',
    'united republic of tanzania': 'TZ', 'state of palestine': 'PS',
    'svalbard and jan mayen islands': 'SJ',
    'wallis and futuna islands': 'WF', 'naoero': 'NR',
    'bolivia (plurinational state of)': 'BO',
    'iran (islamic republic of)': 'IR',
    'netherlands (kingdom of the)': 'NL',
    'venezuela (bolivarian republic of)': 'VE',
    'china, hong kong special administrative region': 'HK',
    'china, macao special administrative region': 'MO',
    // CLDR alternative territory names (short, variant and Chagos forms).
    'cocos islands': 'CC', 'congo (drc)': 'CD',
    'congo (republic)': 'CG',
    'falkland islands (islas malvinas)': 'FK',
    'chagos archipelago': 'IO', 'aotearoa new zealand': 'NZ'
  })) countries.set(locationKey(name), code);

  // CLDR territory-containment region identifiers (including groupings).
  // Intl.DisplayNames provides the CLDR English names, not a second
  // manually maintained region-name table.
  const regionCodes = new Map();
  for (const code of ('001 002 003 005 009 011 013 014 015 017 018 019 ' +
    '021 029 030 034 035 039 053 054 057 061 142 143 145 150 ' +
    '151 154 155 202 419 EU EZ QO UN').split(' ')) {
    const name = regionNames.of(code);
    if (name !== code) regionCodes.set(locationKey(name), code);
    regionCodes.set(locationKey(code), code);
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
  })) regionCodes.set(locationKey(name), code);
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
  // UN M49 Southern Asia (034); match resolved ISO codes so CLDR names,
  // country aliases and alpha-2/alpha-3 identifiers receive the same colour.
  const southAsianCountries = new Set([
    'AF', 'BD', 'BT', 'IN', 'IR', 'MV', 'NP', 'PK', 'LK'
  ]);
  const SOUTH_ASIA_BACKGROUND = '#fca5a5'; // Tailwind red-300
  const SOUTH_ASIA_TEXT = '#7f1d1d'; // Tailwind red-900

  let scanTimer = null;
  let retryTimer = null;
  let retryAt = 0;

  function locationLabel(location) {
    if (!location) return '';
    const key = locationKey(location);
    const code = countries.get(key);
    if (code) {
      const flag = String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
      return flag + ' ' + countryCodes.get(code);
    }
    const region = regionCodes.get(key);
    if (region) return regionAbbreviations[region] || regionNames.of(region);
    return otherAbbreviations[key] || location;
  }

  function isSouthAsianLocation(location) {
    const key = locationKey(location);
    return southAsianCountries.has(countries.get(key)) || regionCodes.get(key) === '034';
  }

  function mentionText(link) {
    // Ignore location chips injected into profile links when matching @handles.
    return (link.childNodes ? [...link.childNodes]
      .filter(node => node.dataset?.xAccountFlag !== 'true')
      .map(node => node.textContent).join('') : link.textContent).trim();
  }

  function hasEmojiNameImage(node) {
    // X replaces emoji in display names with img elements. An arbitrary image
    // in an avatar or affiliation is not evidence of a display name.
    return [...(node.querySelectorAll?.('img[alt]') || [])]
      .some(img => /(?:[\p{Extended_Pictographic}\p{Regional_Indicator}]|[0-9#*]\uFE0F?\u20E3)/u
        .test(img.getAttribute('alt') || '') &&
        !/\p{L}/u.test(img.getAttribute('alt') || ''));
  }

  function hasDisplayName(node) {
    const text = node.textContent.trim();
    return Boolean(text) || hasEmojiNameImage(node);
  }

  function isNameCandidate(node) {
    // These decorations can themselves contain an emoji; that alone does not
    // make them the account display name. Inspect ancestors as well as the
    // image, since X often wraps avatar and affiliation artwork in div[dir=ltr].
    if (node.closest?.('[data-testid*="Avatar" i], [data-testid*="Affiliation" i], ' +
      '[class*="avatar" i], [class*="affiliation" i], [id*="avatar" i], [id*="affiliation" i]')) {
      return false;
    }
    if (node.querySelector?.('img[src*="/profile_images/"]')) return false;
    return hasDisplayName(node);
  }

  function styleHeaderRow(row) {
    if (!headerRowStyles.has(row)) {
      headerRowStyles.set(row, {
        flexDirection: row.style.flexDirection,
        alignItems: row.style.alignItems,
        flexPriority: row.style.getPropertyPriority?.('flex-direction') || '',
        alignPriority: row.style.getPropertyPriority?.('align-items') || ''
      });
    }
    // A low-priority CSS rule supplies flex display without defeating X's
    // own display:none rules (including classes applied after insertion).
    row.setAttribute?.('data-x-account-flag-header', 'true');
    row.style.flexDirection = 'row';
    row.style.alignItems = 'center';
  }

  function restoreHeaderRow(row) {
    const original = headerRowStyles.get(row);
    if (!original) return;
    row.removeAttribute?.('data-x-account-flag-header');
    for (const [name, property, priority] of [
      ['flexDirection', 'flex-direction', 'flexPriority'],
      ['alignItems', 'align-items', 'alignPriority']
    ]) {
      if (original[name]) {
        if (row.style.setProperty) {
          row.style.setProperty(property, original[name], original[priority]);
        } else {
          row.style[name] = original[name];
        }
      } else if (row.style.removeProperty) {
        row.style.removeProperty(property);
      } else {
        delete row.style[name];
      }
    }
    headerRowStyles.delete(row);
  }

  function restoreUnusedHeaderRows() {
    for (const row of headerRowStyles.keys()) {
      // X virtualizes timeline items by detaching entire rows. Their chips
      // remain children of the detached node, but must not keep the row alive
      // through this Map after the next mutation-driven scan.
      if (row.isConnected === false ||
        ![...(row.children || [])].some(child => child.dataset?.xAccountFlag === 'true')) {
        restoreHeaderRow(row);
      }
    }
  }

  function findHandles(root = document) {
    const containers = [];
    if (root.matches?.(USER_SELECTOR)) containers.push(root);
    containers.push(...root.querySelectorAll(USER_SELECTOR));
    const found = [];
    const seen = new Set();
    for (const container of containers) {
      const type = container.getAttribute?.('data-testid');
      // UserCell also contains bio links. Only decorate the account header,
      // identified by a display-name link AND its matching @handle link.
      const links = [...container.querySelectorAll('a[href]')];
      const handles = new Map();
      for (const [index, link] of links.entries()) {
        if (link.getAttribute('tabindex') !== '-1') continue;
        const value = link.textContent.trim();
        const path = link.getAttribute('href');
        if (!path || !/^@[a-zA-Z0-9_]{1,15}$/.test(value)) continue;
        if (path.toLowerCase() === '/' + value.slice(1).toLowerCase()) {
          const username = value.slice(1).toLowerCase();
          if (!handles.has(username)) handles.set(username, index);
        }
      }
      let foundHeader = false;
      // Prefer the link nearest the @handle, not an earlier avatar link.
      for (let i = links.length - 1; i >= 0; i--) {
        const link = links[i];
        if (link.getAttribute('tabindex') === '-1') continue;
        if (link.getAttribute('role') !== 'link') continue;
        if (link.closest?.('[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"]')) continue;
        const path = link.getAttribute('href');
        const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(path || '');
        if (!match || !handles.has(match[1].toLowerCase())) continue;
        // Bio links appear after the account's handle in a UserCell.
        if (i >= handles.get(match[1].toLowerCase())) continue;
        // The display-name link is distinct from the handle and avatar links.
        if (!isNameCandidate(link)) continue;
        if (seen.has(link)) continue;
        seen.add(link);
        found.push({ link, username: match[1].toLowerCase(), placement: 'header' });
        foundHeader = true;
        break;
      }
      // Quoted posts and profile headers can have non-link display names and
      // a tabindex=-1 handle wrapper, unlike regular tweet headers.
      if (!foundHeader && type !== 'UserCell' && type !== 'UserDescription') {
        const handle = [...container.querySelectorAll('[tabindex="-1"]')]
          .map(node => /^@([a-zA-Z0-9_]{1,15})$/.exec(node.textContent.trim()))
          .find(Boolean);
        if (handle) {
          const nameNodes = [...container.querySelectorAll('div[dir="ltr"]')];
          const handleIndex = nameNodes.findIndex(node =>
            node.closest?.('[tabindex="-1"]'));
          const candidates = handleIndex < 0 ? nameNodes : nameNodes.slice(0, handleIndex);
          // The display name comes before affiliation and other metadata.
          // This fallback is only for plain-text names. If React removes an
          // account link's href while recycling a row, descendants inside that
          // link must not become a second, fake display-name match.
          const name = candidates.find(node =>
            !node.closest?.('a, [tabindex="-1"]') &&
            isNameCandidate(node));
          if (name && !seen.has(name)) {
            seen.add(name);
            found.push({ link: name, username: handle[1].toLowerCase(), placement: 'header' });
          }
        }
      }
      // UserCell biographies and profile descriptions contain @mentions with
      // their own locations, separate from the displayed account identity.
      if (type === 'UserCell' || type === 'UserDescription') {
        const bioLinks = type === 'UserCell'
          ? container.querySelectorAll('div[dir="auto"] a[href]') : links;
        for (const link of bioLinks) {
          const path = link.getAttribute('href') || '';
          const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(path);
          if (!match || mentionText(link).toLowerCase() !== '@' + match[1].toLowerCase()) continue;
          if (seen.has(link)) continue;
          seen.add(link);
          found.push({ link, username: match[1].toLowerCase(),
            placement: type === 'UserDescription' ? 'profile-mention' : 'mention' });
        }
      }
    }
    // Public, logged-out X pages render name and handle as adjacent links to
    // the same profile, without the data-testid containers used above. Match
    // only within their small shared row: a handle alone (e.g. a biography
    // mention) or a profile avatar must never be mistaken for a display name.
    for (const handleLink of root.querySelectorAll('a[href]')) {
      if (handleLink.closest(USER_SELECTOR)) continue;
      const path = handleLink.getAttribute('href') || '';
      const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(path);
      if (!match) continue;
      const username = match[1].toLowerCase();
      if (mentionText(handleLink).toLowerCase() !== '@' + username) continue;
      const row = handleLink.parentElement?.parentElement;
      if (!row || row === document.body) continue;
      const links = [...row.querySelectorAll('a[href]')];
      const index = links.indexOf(handleLink);
      const name = links.slice(0, index).reverse().find(link =>
        link.getAttribute('href')?.toLowerCase().replace(/\/$/, '') === '/' + username &&
        !link.querySelector('.x-avatar, [data-testid="Tweet-User-Avatar"], img[src*="/profile_images/"]') &&
        hasDisplayName(link));
      if (!name || seen.has(name)) continue;
      seen.add(name);
      found.push({ link: name, username, placement: 'header' });
    }
    // The main header of a public profile is different again: its display
    // name is an h1 and the matching @handle is plain text, with no profile
    // links. Scope this to the visited profile route so unrelated headings
    // and account references elsewhere on the page cannot acquire chips.
    const profile = /^\/([a-zA-Z0-9_]{1,15})(?:\/(?:with_replies|media|likes|highlights|articles))?\/?$/
      .exec(location.pathname);
    if (profile) {
      const username = profile[1].toLowerCase();
      for (const name of root.querySelectorAll('h1')) {
        if (name.closest(USER_SELECTOR) || seen.has(name) || !hasDisplayName(name)) continue;
        const header = name.parentElement?.parentElement;
        if (!header) continue;
        const hasHandle = [...header.querySelectorAll('span')].some(node =>
          node.childElementCount === 0 &&
          node.textContent.trim().toLowerCase() === '@' + username);
        if (!hasHandle) continue;
        seen.add(name);
        found.push({ link: name, username, placement: 'header' });
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

  function paint({ link, username, placement }, entry) {
    // Profile descriptions can contain multiple mentions in one inline span.
    // Place each chip inside its link so it wraps with that mention, without
    // reparenting React's link or changing the surrounding bio layout.
    const profileMention = placement === 'profile-mention';
    const row = profileMention ? link : link.parentElement;
    if (!row) return;
    const existing = [...(row.children || [])].filter(child =>
      child.dataset?.xAccountFlag === 'true');
    let badge = existing.find(child => child.dataset.xAccountHandle === username);
    for (const old of existing) if (old !== badge) old.remove();
    const location = typeof entry?.country === 'string' ? entry.country.trim() : '';
    const display = locationLabel(location);
    // Pending, empty and failed lookups do not create placeholder elements.
    if (!display) {
      badge?.remove();
      restoreUnusedHeaderRows();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.dataset.xAccountFlag = 'true';
      badge.dataset.xAccountHandle = username;
      badge.style.display = 'inline-block';
      badge.style.boxSizing = 'border-box';
      badge.style.flex = '0 0 auto';
      badge.style.whiteSpace = 'nowrap';
      badge.style.alignSelf = 'center';
      badge.style.verticalAlign = 'middle';
      badge.style.lineHeight = '1.25rem';
      badge.style.height = '1.25rem';
    }
    badge.style.marginInlineEnd = '0.35rem';
    badge.style.marginInlineStart = placement === 'header' ? '0' : '0.25rem';
    if (profileMention) {
      badge.style.flex = '0 1 auto';
      badge.style.minWidth = '0';
      badge.style.maxWidth = '100%';
      badge.style.overflow = 'hidden';
      badge.style.textOverflow = 'ellipsis';
      if (badge.parentElement !== link || badge !== link.firstElementChild) {
        link.insertBefore(badge, link.firstChild);
      }
    } else {
      if (placement === 'header') {
        // Do not overwrite X's hidden state with our inline flex display.
        // Hidden rows can still be mounted and fetched before they are shown.
        if (row.hidden || row.closest?.('[hidden]') ||
          row.classList?.contains('hidden') ||
          window.getComputedStyle?.(row).display === 'none') {
          badge?.remove();
          restoreUnusedHeaderRows();
          return;
        }
        // X's inner display-name wrapper defaults to a flex column.
        styleHeaderRow(row);
      }
      if (badge.parentElement !== row || badge.nextElementSibling !== link) {
        row.insertBefore(badge, link);
      }
    }

    if (badge.textContent !== display) badge.textContent = display;
    badge.style.fontFamily = CHIP_FONT_FAMILY;
    badge.style.fontSize = '0.75rem';
    badge.style.paddingInline = '0.35rem';
    const southAsia = isSouthAsianLocation(location);
    badge.style.backgroundColor = southAsia ? SOUTH_ASIA_BACKGROUND : '#f5f5f5';
    badge.style.color = southAsia ? SOUTH_ASIA_TEXT : '#171717';
    badge.style.borderRadius = '0';
    const label = 'Account based in ' + location + ' (according to X)' +
      (entry.accurate === false ? '; X marks this location as uncertain' : '');
    badge.title = label;
    badge.setAttribute('aria-label', label);
  }

  function paintUsername(username) {
    const current = entries.get(username);
    const valid = current?.expires > Date.now() ? current : null;
    for (const item of findHandles()) {
      if (item.username === username) paint(item, valid);
    }
  }

  function enqueue(username, priority = false) {
    const current = entries.get(username);
    if (current?.expires > Date.now() || inFlight.has(username)) return;
    if (queued.has(username)) {
      if (priority) {
        urgent.add(username);
        const index = queue.indexOf(username);
        if (index > 0) queue.unshift(...queue.splice(index, 1));
      }
    } else {
      // New visible rows must not get stuck behind a full prefetch queue.
      if (priority && queue.length >= MAX_QUEUE) {
        const index = queue.findLastIndex(name => !urgent.has(name));
        if (index >= 0) {
          const dropped = queue.splice(index, 1)[0];
          queued.delete(dropped);
        }
      }
      if (queue.length < MAX_QUEUE) {
        queued.add(username);
        if (priority) {
          urgent.add(username);
          queue.unshift(username);
        } else {
          queue.push(username);
        }
      }
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
    const items = findHandles();
    // React can reuse an existing row while its name/handle are being changed.
    // Reconcile every chip with currently matched names, not just bio links.
    const validBadges = new Map();
    for (const item of items) {
      const row = item.placement === 'profile-mention' ? item.link : item.link.parentElement;
      if (!row) continue;
      if (!validBadges.has(row)) validBadges.set(row, new Set());
      validBadges.get(row).add(item.username);
    }
    for (const badge of document.querySelectorAll('[data-x-account-flag="true"]')) {
      if (!validBadges.get(badge.parentElement)?.has(badge.dataset.xAccountHandle)) {
        badge.remove();
      }
    }
    restoreUnusedHeaderRows();
    const mountedNames = new Set(items.map(item => item.username));
    // React unmounts virtualized rows; discard queued work for removed rows.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!mountedNames.has(queue[i])) {
        queued.delete(queue[i]);
        urgent.delete(queue[i]);
        queue.splice(i, 1);
      }
    }
    for (const item of items) {
      const current = entries.get(item.username);
      paint(item, current?.expires > Date.now() ? current : null);
    }
    // Prefetch all DOM-mounted accounts, not just accounts already in view.
    // Prioritize visible rows if the page contains a large batch.
    for (const item of items) {
      if (visible(item.link)) enqueue(item.username, true);
    }
    for (const item of items) {
      if (!visible(item.link)) enqueue(item.username);
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
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['href', 'alt', 'class', 'hidden'],
    characterData: true
  });
  scan();
})();
