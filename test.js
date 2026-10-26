// No dependencies, real extension scripts executed in isolated VM worlds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(name, context) {
  vm.runInNewContext(fs.readFileSync(__dirname + '/' + name, 'utf8'), context, {
    filename: name
  });
}

function response(status = 200, data = { code: 200, about_account: { based_in: 'Japan', location_accurate: true } }, headers = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: new Headers(headers), json: async () => data };
}

function backgroundFixture(fetchImpl = async () => response(), storage = {}) {
  const calls = [], handlers = [];
  const browser = {
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .map(key => [key, storage[key]]));
      },
      async set(value) { Object.assign(storage, value); }
    } },
    runtime: { onMessage: { addListener(fn) { handlers.push(fn); } } }
  };
  load('background.js', {
    browser, Headers, AbortController, Date, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options);
    }
  });
  async function send(username, priority = false) {
    return handlers[0]({ type: 'lookup', username, priority });
  }
  return { browser, storage, calls, send };
}

async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function contrastRatio(foreground, background) {
  function luminance(hex) {
    const channels = hex.match(/[0-9a-f]{2}/gi).map(channel => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('FxTwitter about endpoint, no cookies, country and accuracy returned', async () => {
  const f = backgroundFixture();
  assert.equal(JSON.stringify(await f.send('alice')), JSON.stringify({
    success: true, country: 'Japan', accurate: true
  }));
  assert.equal(f.calls[0].url, 'https://api.fxtwitter.com/2/profile/alice/about');
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(f.calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(f.calls[0].options.headers, undefined);
  await waitFor(() => !!f.storage['fxtwitter-locations-v1']?.alice);
  assert.equal(f.storage['fxtwitter-locations-v1'].alice.country, 'Japan');
});

test('case-insensitive handle cache avoids repeat requests', async () => {
  const f = backgroundFixture();
  assert.equal((await f.send('ALICE')).country, 'Japan');
  assert.equal((await f.send('Alice')).country, 'Japan');
  assert.equal(f.calls.length, 1);
});

test('coalesces concurrent lookups across tabs', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = backgroundFixture(async () => { await gate; return response(); });
  const first = f.send('bob');
  const second = f.send('bob');
  await waitFor(() => f.calls.length === 1);
  release();
  const values = await Promise.all([first, second]);
  assert.equal(values[0].country, 'Japan');
  assert.equal(values[1].country, 'Japan');
  assert.equal(f.calls.length, 1);
});

test('invalid handles are rejected before any request', async () => {
  const f = backgroundFixture();
  for (const handle of ['', '../secret', 'name/status/1', 'x'.repeat(16)]) {
    assert.equal(await f.send(handle), undefined);
  }
  assert.equal(f.calls.length, 0);
});

test('missing about metadata caches a valid empty answer', async () => {
  const f = backgroundFixture(async () => response(200, { code: 200, message: 'OK' }));
  const result = await f.send('alice');
  assert.equal(result.success, true);
  assert.equal(result.country, null);
  await f.send('alice');
  assert.equal(f.calls.length, 1);
});

test('HTTP 200 with API error is not cached as an empty account', async () => {
  const f = backgroundFixture(async () => response(200, { code: 500, message: 'Upstream error' }));
  assert.equal((await f.send('alice')).success, false);
  assert.equal((await f.send('alice')).success, false);
  assert.equal(f.calls.length, 2);
});

test('HTTP 429 pauses the service and persists cooldown across background restarts', async () => {
  const f = backgroundFixture(async () => response(429, { code: 429 }, { 'retry-after': '40' }));
  const value = await f.send('alice');
  assert.equal(value.success, false);
  assert.ok(value.retryAt - Date.now() > 39000);
  const next = await f.send('bob');
  assert.equal(next.retryAt, value.retryAt);
  assert.equal(f.calls.length, 1);
  const again = backgroundFixture(async () => response(), f.storage);
  const afterRestart = await again.send('carol');
  assert.equal(afterRestart.retryAt, value.retryAt);
  assert.equal(again.calls.length, 0);
});


// Layout fixture mirrors X's regular User-Name, quoted-post User-Name
// (plain name/handle without links), and UserCell account and biography DOM.
function contentFixture(options = {}) {
  const calls = [], listeners = new Map(), badges = new Map();
  const accounts = options.accounts || [
    { handle: 'Alice', name: 'Alice', type: 'User-Name' },
    { handle: 'Bob', name: 'Bob', type: 'User-Name' },
    { handle: 'Carol', name: 'Carol', type: 'User-Name', offscreen: true }
  ];
  const locations = options.locations || {};
  const rows = [], links = [], containers = [], handleLinks = [], bioRows = [];

  function element(attrs = {}) {
    return {
      ...attrs,
      dataset: attrs.dataset || {}, style: attrs.style || {},
      parentElement: null,
      get nextElementSibling() {
        const children = this.parentElement?.children || [];
        return children[children.indexOf(this) + 1] || null;
      },
      get nextSibling() { return this.nextElementSibling; },
      get previousElementSibling() {
        const children = this.parentElement?.children || [];
        return children[children.indexOf(this) - 1] || null;
      },
      remove() {
        const children = this.parentElement?.children || [];
        const index = children.indexOf(this);
        if (index >= 0) children.splice(index, 1);
        this.parentElement = null;
      },
      insertBefore(child, anchor) {
        this.insertions = (this.insertions || 0) + 1;
        if (child.parentElement) child.remove();
        const children = this.children ||= [];
        const index = anchor ? children.indexOf(anchor) : children.length;
        children.splice(index < 0 ? children.length : index, 0, child);
        child.parentElement = this;
      },
      getAttribute(key) { return this.attrs?.[key] ?? null; },
      setAttribute(key, value) { (this.attrs ||= {})[key] = value; },
      removeAttribute(key) { if (this.attrs) delete this.attrs[key]; }
    };
  }
  const bounds = acct => acct.offscreen
    ? { top: 1500, bottom: 1520, left: 0, right: 80 }
    : { top: 40, bottom: 60, left: 0, right: 80 };

  for (const acct of accounts) {
    const display = element({
      attrs: acct.quoted ? { dir: 'ltr' } : { href: '/' + acct.handle, role: 'link' },
      textContent: acct.name,
      getBoundingClientRect: () => bounds(acct)
    });
    const handle = element({
      attrs: acct.quoted ? { tabindex: '-1' } :
        { href: '/' + acct.handle, role: 'link', tabindex: '-1' },
      textContent: '@' + acct.handle
    });
    const avatar = element({
      attrs: { href: '/' + acct.handle, role: 'link', tabindex: '-1' },
      textContent: ''
    });
    const row = {
      style: {},
      children: [display],
      insertions: 0,
      insertBefore(child, anchor) {
        this.insertions++;
        if (child.parentElement) child.remove();
        const at = anchor ? this.children.indexOf(anchor) : this.children.length;
        this.children.splice(at < 0 ? this.children.length : at, 0, child);
        child.parentElement = this;
        badges.set(acct.handle, child);
      }
    };
    display.parentElement = row;
    const mentions = (acct.bio || []).map(name => {
      const link = element({
        attrs: { href: '/' + name, role: 'link' },
        textContent: '@' + name,
        getBoundingClientRect: () => bounds(acct)
      });
      const wrapper = element({ children: [link] });
      const inlineRow = {
        style: {}, children: [wrapper], insertions: 0,
        insertBefore(child, anchor) {
          this.insertions++;
          if (child.parentElement) child.remove();
          const index = anchor ? this.children.indexOf(anchor) : this.children.length;
          this.children.splice(index < 0 ? this.children.length : index, 0, child);
          child.parentElement = this;
        }
      };
      link.parentElement = wrapper;
      wrapper.parentElement = inlineRow;
      return { link, row: inlineRow, name };
    });
    const bioLinks = mentions.map(item => item.link);
    bioRows.push(mentions);
    const allLinks = acct.quoted ? [] : [avatar, display, handle, ...bioLinks];
    const container = {
      type: acct.type,
      getAttribute(name) {
        return name === 'data-testid' ? acct.type : null;
      },
      matches() { return true; },
      querySelectorAll(selector) {
        if (selector === 'a[href]') return allLinks;
        if (selector === 'div[dir="auto"] a[href]') return bioLinks;
        if (selector === '[tabindex="-1"]') return acct.quoted ? [handle] : [];
        if (selector === 'div[dir="ltr"]') return acct.quoted
          ? [display, element({ textContent: '@' + acct.handle }),
            element({ textContent: '9h' })] : [];
        if (selector === '[data-x-account-flag]') {
          return [
            ...row.children.filter(x => x.dataset?.xAccountFlag === 'true'),
            ...mentions.flatMap(item => item.row.children.filter(x => x.dataset?.xAccountFlag === 'true'))
          ];
        }
        return [];
      }
    };
    display.closest = selector => selector === '[data-testid="UserCell"]' &&
      acct.type === 'UserCell' ? container : null;
    containers.push(container);
    rows.push(row);
    links.push(display);
    handleLinks.push(handle);
  }
  const document = {
    documentElement: { clientHeight: 800, clientWidth: 900 },
    querySelectorAll: selector => selector.startsWith('[data-testid=')
      ? containers : [],
    addEventListener(name, fn) { listeners.set(name, fn); },
    createElement: () => element({ textContent: '' })
  };
  const window = {
    innerHeight: 800, innerWidth: 900,
    addEventListener(name, fn) { listeners.set(name, fn); }
  };
  const browser = {
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        if (options.lookup) return options.lookup(message);
        return {
          success: true,
          country: Object.hasOwn(locations, message.username)
            ? locations[message.username] : 'Japan',
          accurate: true
        };
      }
    }
  };
  load('content.js', {
    document, window, browser, Date, Intl, URL,
    setTimeout, clearTimeout,
    location: { origin: 'https://x.com', href: 'https://x.com/home' },
    MutationObserver: class { observe() {} }
  });
  const badge = index => rows[index].children.find(node => node.dataset?.xAccountFlag);
  return { calls, listeners, links, handleLinks, rows, containers,
    badges, badge, bioRows };
}

test('all DOM-mounted accounts are prefetched before they enter the viewport', async () => {
  const f = contentFixture();
  await waitFor(() => f.badge(0)?.textContent === '🇯🇵 JPN' &&
    f.badge(1)?.textContent === '🇯🇵 JPN' &&
    f.badge(2)?.textContent === '🇯🇵 JPN');
  assert.deepEqual(f.calls.map(c => c.username).sort(), ['alice', 'bob', 'carol']);
});

test('chip takes its intrinsic width immediately BEFORE display-name link', async () => {
  const f = contentFixture();
  await waitFor(() => f.badge(0)?.textContent === '🇯🇵 JPN');
  const [badge, name] = f.rows[0].children;
  assert.equal(name, f.links[0]);
  assert.equal(f.badge(0), badge);
  assert.equal(f.rows[0].style.flexDirection, 'row');
  assert.equal(f.rows[0].style.alignItems, 'center');
  assert.equal(badge.style.marginInlineStart, '0');
  assert.equal(badge.style.width, undefined);
  assert.equal(badge.style.minWidth, undefined);
  assert.equal(badge.style.maxWidth, undefined);
  assert.equal(badge.style.flex, '0 0 auto');
  assert.equal(badge.style.backgroundColor, '#f5f5f5');
  assert.equal(badge.style.paddingInline, '0.35rem');
  assert.equal(name.textContent, 'Alice');
});

test('broad geographical regions have square light-background chips', async () => {
  const f = contentFixture({ locations: { alice: 'East Asia', bob: 'Europe' } });
  await waitFor(() => f.badge(0)?.textContent === 'E Asia' &&
    f.badge(1)?.textContent === 'Europe');
  const badge = f.badge(0);
  assert.equal(badge.style.backgroundColor, '#f5f5f5');
  assert.equal(badge.style.color, '#171717');
  assert.equal(badge.style.paddingInline, '0.35rem');
  assert.equal(badge.style.borderRadius, '0');
  assert.equal(badge.style.boxSizing, 'border-box');
  assert.equal(badge.style.width, undefined);
  assert.equal(badge.style.textOverflow, undefined);
  assert.equal(badge.style.whiteSpace, 'nowrap');
  assert.equal(badge.title, 'Account based in East Asia (according to X)');
});

test('ISO alpha-3 chips resolve country names, aliases and alpha-2/3 codes', async () => {
  const cases = [
    ['Japan', '🇯🇵 JPN'], ['JP', '🇯🇵 JPN'], ['JPN', '🇯🇵 JPN'],
    ['United States of America', '🇺🇸 USA'], ['USA', '🇺🇸 USA'],
    ['UK', '🇬🇧 GBR'], ['United Kingdom', '🇬🇧 GBR'],
    ['South Korea', '🇰🇷 KOR'], ['Czech Republic', '🇨🇿 CZE'],
    ['Ivory Coast', '🇨🇮 CIV'], ['South Africa', '🇿🇦 ZAF'],
    ['Viet Nam', '🇻🇳 VNM'], ['Vietnam', '🇻🇳 VNM'],
    ['Bosnia and Herzegovina', '🇧🇦 BIH'],
    ['Bosnia & Herzegovina', '🇧🇦 BIH'],
    ['Hong Kong', '🇭🇰 HKG'], ['Palestine', '🇵🇸 PSE']
  ];
  const f = contentFixture({
    accounts: cases.map((_, i) => ({ handle: 'Country' + i, name: 'Country ' + i })),
    locations: Object.fromEntries(cases.map(([location], i) => ['country' + i, location]))
  });
  await waitFor(() => cases.every(([, label], i) => f.badge(i)?.textContent === label));
  assert.deepEqual(cases.map((_, i) => f.badge(i)?.textContent),
    cases.map(([, label]) => label));
  for (const [i, [location, label]] of cases.entries()) {
    const badge = f.badge(i);
    assert.equal(badge.textContent, label);
    assert.equal(badge.style.backgroundColor, '#f5f5f5');
    assert.equal(badge.style.paddingInline, '0.35rem');
    assert.equal(badge.title, 'Account based in ' + location + ' (according to X)');
  }
});

test('ISO English country names omitted by CLDR resolve to their ISO flags', async () => {
  // ISO 3166-1 English short names missing from Intl.DisplayNames(en).
  const cases = [
    ['Bonaire, Sint Eustatius and Saba', 'BQ', 'BES'],
    ['Bolivia, Plurinational State of', 'BO', 'BOL'],
    ['Brunei Darussalam', 'BN', 'BRN'],
    ['Congo, The Democratic Republic of the', 'CD', 'COD'],
    ['Congo', 'CG', 'COG'], ['Cabo Verde', 'CV', 'CPV'],
    ['Falkland Islands (Malvinas)', 'FK', 'FLK'],
    ['Micronesia, Federated States of', 'FM', 'FSM'],
    ['Heard Island and McDonald Islands', 'HM', 'HMD'],
    ['Iran, Islamic Republic of', 'IR', 'IRN'],
    ['Korea, Republic of', 'KR', 'KOR'],
    ["Lao People's Democratic Republic", 'LA', 'LAO'],
    ['Saint Martin (French part)', 'MF', 'MAF'],
    ['Moldova, Republic of', 'MD', 'MDA'], ['Myanmar', 'MM', 'MMR'],
    ['Pitcairn', 'PN', 'PCN'],
    ["Korea, Democratic People's Republic of", 'KP', 'PRK'],
    ['Palestine, State of', 'PS', 'PSE'],
    ['Russian Federation', 'RU', 'RUS'],
    ['South Georgia and the South Sandwich Islands', 'GS', 'SGS'],
    ['Saint Helena, Ascension and Tristan da Cunha', 'SH', 'SHN'],
    ['Sint Maarten (Dutch part)', 'SX', 'SXM'],
    ['Syrian Arab Republic', 'SY', 'SYR'],
    ['Taiwan, Province of China', 'TW', 'TWN'],
    ['Tanzania, United Republic of', 'TZ', 'TZA'],
    ['United States Minor Outlying Islands', 'UM', 'UMI'],
    ['Holy See (Vatican City State)', 'VA', 'VAT'],
    ['Saint Vincent and the Grenadines', 'VC', 'VCT'],
    ['Venezuela, Bolivarian Republic of', 'VE', 'VEN'],
    ['Virgin Islands, British', 'VG', 'VGB'],
    ['Virgin Islands, U.S.', 'VI', 'VIR'],
    // ISO/CLDR differences handled by typography normalization.
    ['Antigua and Barbuda', 'AG', 'ATG'],
    ['Bosnia and Herzegovina', 'BA', 'BIH'],
    ['Saint Barthélemy', 'BL', 'BLM'],
    ["Côte d'Ivoire", 'CI', 'CIV'],
    ['Hong Kong', 'HK', 'HKG'],
    ['Saint Kitts and Nevis', 'KN', 'KNA'],
    ['Saint Lucia', 'LC', 'LCA'],
    ['Macao', 'MO', 'MAC'],
    ['Saint Pierre and Miquelon', 'PM', 'SPM'],
    ['Svalbard and Jan Mayen', 'SJ', 'SJM'],
    ['Sao Tome and Principe', 'ST', 'STP'],
    ['Turks and Caicos Islands', 'TC', 'TCA'],
    ['Trinidad and Tobago', 'TT', 'TTO'],
    ['Wallis and Futuna', 'WF', 'WLF']
  ];
  const f = contentFixture({
    accounts: cases.map((_, i) => ({ handle: 'Iso' + i, name: 'ISO ' + i })),
    locations: Object.fromEntries(cases.map(([location], i) => ['iso' + i, location]))
  });
  await waitFor(() => cases.every((_, i) => !!f.badge(i)));
  for (const [i, [location, code, alpha3]] of cases.entries()) {
    const flag = String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
    assert.equal(f.badge(i).textContent, flag + ' ' + alpha3, location);
  }
});

test('X variants, diacritics, ampersands and whitespace resolve consistently', async () => {
  const cases = [
    ['Macedonia', '🇲🇰 MKD'], ['East Timor', '🇹🇱 TLS'],
    ['Bonaire', '🇧🇶 BES'], ['Swaziland', '🇸🇿 SWZ'],
    ['Burma', '🇲🇲 MMR'], ['Holy See', '🇻🇦 VAT'],
    ['Reunion', '🇷🇪 REU'], ['Réunion', '🇷🇪 REU'],
    ['Sao Tome and Principe', '🇸🇹 STP'],
    ["Côte d'Ivoire", '🇨🇮 CIV'], ['Côte d’Ivoire', '🇨🇮 CIV'],
    ["Cote d'Ivoire", '🇨🇮 CIV'],
    ['Antigua and Barbuda', '🇦🇬 ATG'],
    ['Bosnia and Herzegovina', '🇧🇦 BIH'],
    ['Bosnia & Herzegovina', '🇧🇦 BIH'],
    ['Saint Lucia', '🇱🇨 LCA'], ['St. Lucia', '🇱🇨 LCA'],
    ['Turkiye', '🇹🇷 TUR'], ['Türkiye', '🇹🇷 TUR'],
    ['Great Britain', '🇬🇧 GBR'],
    ['United Kingdom of Great Britain and Northern Ireland', '🇬🇧 GBR'],
    ['UAE', '🇦🇪 ARE'], ['  Viet   Nam  ', '🇻🇳 VNM'],
    ['Republic of Moldova', '🇲🇩 MDA'],
    ['Federated States of Micronesia', '🇫🇲 FSM']
  ];
  const f = contentFixture({
    accounts: cases.map((_, i) => ({ handle: 'Alias' + i, name: 'Alias ' + i })),
    locations: Object.fromEntries(cases.map(([location], i) => ['alias' + i, location]))
  });
  await waitFor(() => cases.every((_, i) => !!f.badge(i)));
  cases.forEach(([location, label], i) => assert.equal(f.badge(i).textContent, label, location));
});

test('peer-reported X labels and CLDR alternative territory names resolve', async () => {
  const cases = [
    ['Bosnia', '🇧🇦 BIH'], ['Britain', '🇬🇧 GBR'],
    ['Svalbard', '🇸🇯 SJM'], ['US Virgin Islands', '🇻🇮 VIR'],
    ['United States Virgin Islands', '🇻🇮 VIR'],
    ['Congo-Brazzaville', '🇨🇬 COG'], ['Congo-Kinshasa', '🇨🇩 COD'],
    ["Democratic People's Republic of Korea", '🇰🇵 PRK'],
    ['Micronesia (Federated States of)', '🇫🇲 FSM'],
    ['United Republic of Tanzania', '🇹🇿 TZA'],
    ['State of Palestine', '🇵🇸 PSE'],
    ['Svalbard and Jan Mayen Islands', '🇸🇯 SJM'],
    ['Wallis and Futuna Islands', '🇼🇫 WLF'], ['Naoero', '🇳🇷 NRU'],
    ['Bolivia (Plurinational State of)', '🇧🇴 BOL'],
    ['Iran (Islamic Republic of)', '🇮🇷 IRN'],
    ['Netherlands (Kingdom of the)', '🇳🇱 NLD'],
    ['Venezuela (Bolivarian Republic of)', '🇻🇪 VEN'],
    ['China, Hong Kong Special Administrative Region', '🇭🇰 HKG'],
    ['China, Macao Special Administrative Region', '🇲🇴 MAC'],
    ['Cocos Islands', '🇨🇨 CCK'], ['Congo (DRC)', '🇨🇩 COD'],
    ['Congo (Republic)', '🇨🇬 COG'],
    ['Falkland Islands (Islas Malvinas)', '🇫🇰 FLK'],
    ['Chagos Archipelago', '🇮🇴 IOT'],
    ['Aotearoa New Zealand', '🇳🇿 NZL']
  ];
  const f = contentFixture({
    accounts: cases.map((_, i) => ({ handle: 'Variant' + i, name: 'Variant ' + i })),
    locations: Object.fromEntries(cases.map(([name], i) => ['variant' + i, name]))
  });
  await waitFor(() => cases.every((_, i) => !!f.badge(i)));
  cases.forEach(([name, label], i) => assert.equal(f.badge(i).textContent, label, name));
});

test('unrecognized locations and broad regions do not acquire country flags', async () => {
  const cases = [
    ['Kosovo', 'Kosovo'], ['XK', 'XK'], ['Atlantis', 'Atlantis'],
    ['Europe', 'Europe'], ['European Union', 'European Union'],
    ['East Asia & Pacific', 'East Asia & Pacific'],
    ['Eastern Europe (Non-EU)', 'Eastern Europe (Non-EU)']
  ];
  const f = contentFixture({
    accounts: cases.map((_, i) => ({ handle: 'Unknown' + i, name: 'Unknown ' + i })),
    locations: Object.fromEntries(cases.map(([name], i) => ['unknown' + i, name]))
  });
  await waitFor(() => cases.every((_, i) => !!f.badge(i)));
  cases.forEach(([name, label], i) => assert.equal(f.badge(i).textContent, label, name));
});

test('CLDR region identifiers and variant names use curated abbreviations', async () => {
  const cases = [
    ['East Asia', 'E Asia'], ['Eastern Asia', 'E Asia'], ['030', 'E Asia'],
    ['Southeast Asia', 'SE Asia'], ['South-eastern Asia', 'SE Asia'],
    ['035', 'SE Asia'], ['Northern Europe', 'N Europe'],
    ['Latin America', 'LATAM'], ['419', 'LATAM'],
    ['Sub-Saharan Africa', 'SSA'], ['202', 'SSA'],
    ['Middle East', 'M East'], ['Central Europe', 'C Europe'],
    ['Europe', 'Europe'], ['EU', 'European Union'],
    ['Atlantis', 'Atlantis'], ['XK', 'XK']
  ];
  const f = contentFixture({
    accounts: cases.map((_, i) => ({ handle: 'Region' + i, name: 'Region ' + i })),
    locations: Object.fromEntries(cases.map(([location], i) => ['region' + i, location]))
  });
  await waitFor(() => cases.every(([, label], i) => f.badge(i)?.textContent === label));
  assert.deepEqual(cases.map((_, i) => f.badge(i)?.textContent),
    cases.map(([, label]) => label));
  for (const [i, [location, label]] of cases.entries()) {
    assert.equal(f.badge(i).textContent, label);
    assert.equal(f.badge(i).title, 'Account based in ' + location + ' (according to X)');
  }
});

test('UN M49 Southern Asia and all nine constituent countries use Tailwind red chips', async () => {
  const countries = [
    ['Afghanistan', 'AF', 'AFG'], ['Bangladesh', 'BD', 'BGD'],
    ['Bhutan', 'BT', 'BTN'], ['India', 'IN', 'IND'],
    ['Iran', 'IR', 'IRN'], ['Maldives', 'MV', 'MDV'],
    ['Nepal', 'NP', 'NPL'], ['Pakistan', 'PK', 'PAK'],
    ['Sri Lanka', 'LK', 'LKA']
  ];
  const cases = [
    ...['South Asia', 'Southern Asia', '034'].map(location => [location, 'S Asia', true]),
    ...countries.flatMap(([name, alpha2, alpha3]) => {
      const flag = String.fromCodePoint(...[...alpha2].map(c => 127397 + c.charCodeAt(0)));
      return [name, alpha2, alpha3].map(location =>
        [location, flag + ' ' + alpha3, true]);
    }),
    ['Iran, Islamic Republic of', '🇮🇷 IRN', true],
    ['Iran (Islamic Republic of)', '🇮🇷 IRN', true],
    ['China', '🇨🇳 CHN', false], ['Myanmar', '🇲🇲 MMR', false],
    ['British Indian Ocean Territory', '🇮🇴 IOT', false],
    ['Southeast Asia', 'SE Asia', false], ['Western Asia', 'W Asia', false],
    ['Asia', 'Asia', false]
  ];
  const f = contentFixture({
    accounts: cases.map((_, i) => ({ handle: 'Place' + i, name: 'Place ' + i })),
    locations: Object.fromEntries(cases.map(([location], i) => ['place' + i, location]))
  });
  await waitFor(() => cases.every((_, i) => !!f.badge(i)));
  for (const [i, [location, label, southAsia]] of cases.entries()) {
    const chip = f.badge(i);
    assert.equal(chip.textContent, label);
    assert.equal(chip.style.backgroundColor, southAsia ? '#fca5a5' : '#f5f5f5', location);
    assert.equal(chip.style.color, southAsia ? '#7f1d1d' : '#171717', location);
    assert.equal(chip.title, 'Account based in ' + location + ' (according to X)');
  }
  const chip = f.badge(0);
  assert.ok(contrastRatio(chip.style.color, chip.style.backgroundColor) >= 4.5,
    'South Asia chip text must meet WCAG AA normal-text contrast');
});

test('South Asian styling applies to inline bio mentions and quoted headers', async () => {
  const f = contentFixture({
    accounts: [
      { type: 'UserCell', handle: 'Alice', name: 'Alice', bio: ['Bob'] },
      { type: 'User-Name', quoted: true, handle: 'Carol', name: 'Carol' }
    ],
    locations: { alice: 'Pakistan', bob: 'South Asia', carol: 'Nepal' }
  });
  await waitFor(() => f.badge(0)?.textContent === '🇵🇰 PAK' &&
    f.badge(1)?.textContent === '🇳🇵 NPL' &&
    f.bioRows[0][0].link.previousElementSibling?.textContent === 'S Asia');
  const chips = [f.badge(0), f.badge(1), f.bioRows[0][0].link.previousElementSibling];
  for (const chip of chips) {
    assert.equal(chip.style.backgroundColor, '#fca5a5');
    assert.equal(chip.style.color, '#7f1d1d');
  }
});

test('no placeholder is inserted while account locations are loading', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = contentFixture({ lookup: () => pending });
  assert.equal(f.badge(0), undefined);
  assert.deepEqual(f.rows[0].children, [f.links[0]]);
  finish({ success: true, country: 'East Asia' });
  await waitFor(() => f.badge(0)?.textContent === 'E Asia');
  assert.equal(f.rows[0].children[0], f.badge(0));
  assert.equal(f.badge(0).style.width, undefined);
  assert.equal(f.badge(0).style.backgroundColor, '#f5f5f5');
  assert.equal(f.rows[0].insertions, 1);
});

test('empty and failed lookups leave no blank slot', async () => {
  for (const result of [
    { success: true, country: null },
    { success: false }
  ]) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = contentFixture({ lookup: () => pending });
    assert.equal(f.badge(0), undefined);
    finish(result);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.badge(0), undefined);
    assert.deepEqual(f.rows[0].children, [f.links[0]]);
  }
});

test('rescans reuse the existing chip rather than duplicating it', async () => {
  const f = contentFixture({ locations: { alice: 'East Asia' } });
  await waitFor(() => f.badge(0)?.textContent === 'E Asia');
  const slot = f.badge(0);
  f.listeners.get('scroll')();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.badge(0), slot);
  assert.equal(f.rows[0].children.length, 2);
  assert.equal(f.rows[0].insertions, 1);
});

test('UserCell puts account badge before display name and keeps bio mentions inline', async () => {
  const f = contentFixture({
    accounts: [{
      type: 'UserCell', handle: 'AyatsunoYuni', name: '유니 Yuni',
      bio: ['StelLive_kr', 'rainydayinabi', 'KA_XA_']
    }],
    locations: {
      ayatsunoyuni: 'Japan',
      stellive_kr: 'South Korea',
      rainydayinabi: 'Korea',
      ka_xa_: 'East Asia'
    }
  });
  await waitFor(() => f.badge(0)?.textContent === '🇯🇵 JPN' &&
    f.bioRows[0][2].link.previousElementSibling?.textContent === 'E Asia');
  assert.deepEqual(f.calls.map(call => call.username).sort(),
    ['ayatsunoyuni', 'stellive_kr', 'rainydayinabi', 'ka_xa_'].sort());
  assert.equal(f.rows[0].children[0], f.badge(0));
  assert.equal(f.rows[0].children[1], f.links[0]);
  assert.equal(f.links[0].textContent, '유니 Yuni');
  assert.equal(f.handleLinks[0].textContent, '@AyatsunoYuni');

  const mentions = f.bioRows[0];
  for (const mention of mentions) {
    assert.equal(mention.row.children.length, 1,
      'do not insert badge beside the inline mention wrapper');
    assert.equal(mention.row.insertions, 0);
    assert.equal(mention.row.children[0].children[1], mention.link);
    assert.equal(mention.row.children[0].children.length, 2);
    assert.equal(mention.row.children[0].children[0].dataset.xAccountFlag, 'true');
  }
  const label = mentions[2].link.previousElementSibling;
  assert.equal(label.style.backgroundColor, '#f5f5f5');
  assert.equal(label.style.color, '#171717');
  assert.equal(label.style.paddingInline, '0.35rem');
  assert.equal(label.style.borderRadius, '0');
  assert.equal(label.style.marginInlineStart, '0.25rem');
  assert.equal(mentions[2].row.style.flexDirection, undefined,
    'do not override inline bio layout');
});

test('UserCell bio location remains inline before @mention across rescans', async () => {
  const f = contentFixture({
    accounts: [{ type: 'UserCell', handle: 'DrLoupis',
      name: 'Dr. Anastasia Maria Loupis', bio: ['DrLoupis__'] }],
    locations: { drloupis: 'United States', drloupis__: 'United States' }
  });
  await waitFor(() => f.badge(0)?.textContent === '🇺🇸 USA' &&
    f.bioRows[0][0].link.previousElementSibling?.textContent === '🇺🇸 USA');
  const mention = f.bioRows[0][0];
  const chip = mention.link.previousElementSibling;
  assert.equal(mention.row.children.length, 1);
  assert.equal(mention.row.children[0].children[0], chip);
  assert.equal(mention.row.children[0].children[1], mention.link);
  assert.equal(chip.style.marginInlineEnd, '0.35rem');
  assert.equal(chip.style.marginInlineStart, '0.25rem');
  assert.equal(mention.row.insertions, 0);
  f.listeners.get('scroll')();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(mention.link.previousElementSibling, chip);
  assert.equal(mention.row.children.length, 1);
  assert.equal(mention.row.children[0].children.length, 2);
  assert.equal(mention.row.children[0].insertions, 1);
  assert.equal(mention.row.insertions, 0);

  // A chip inserted by an older version after the link must be moved, not duplicated.
  const wrapper = mention.row.children[0];
  wrapper.insertBefore(chip, null);
  chip.style.marginInlineStart = '0.35rem';
  chip.style.marginInlineEnd = '0';
  f.listeners.get('scroll')();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(wrapper.children.length, 2);
  assert.equal(wrapper.children[0], chip);
  assert.equal(wrapper.children[1], mention.link);
  assert.equal(chip.style.marginInlineStart, '0.25rem');
  assert.equal(chip.style.marginInlineEnd, '0.35rem');
});

test('quoted-post header with plain-text name and tabindex handle renders location', async () => {
  const f = contentFixture({
    accounts: [{ type: 'User-Name', quoted: true,
      handle: 'PeterJ_Walker', name: 'Peter Walker' }],
    locations: { peterj_walker: 'United States' }
  });
  await waitFor(() => f.badge(0)?.textContent === '🇺🇸 USA');
  assert.deepEqual(f.calls.map(call => call.username), ['peterj_walker']);
  assert.equal(f.rows[0].children[0], f.badge(0));
  assert.equal(f.rows[0].children[1], f.links[0]);
  assert.equal(f.rows[0].style.flexDirection, 'row');
  assert.equal(f.badge(0).style.flex, '0 0 auto');
  assert.equal(f.badge(0).style.width, undefined);
  f.listeners.get('scroll')();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.rows[0].children.length, 2);
  assert.equal(f.rows[0].insertions, 1);
  assert.equal(f.calls.length, 1);
});

test('UserCell account, mentions and quoted header remain distinct', async () => {
  const f = contentFixture({
    accounts: [
      { type: 'UserCell', handle: 'PeterJ_Walker', name: 'Peter Walker',
        bio: ['OpenRouter', 'cartainc'] },
      { type: 'User-Name', quoted: true, handle: 'PeterJ_Walker',
        name: 'Peter Walker' }
    ],
    locations: { peterj_walker: 'United States', openrouter: 'United States',
      cartainc: 'United States' }
  });
  await waitFor(() => f.badge(0)?.textContent === '🇺🇸 USA' &&
    f.badge(1)?.textContent === '🇺🇸 USA' &&
    f.bioRows[0].every(mention => mention.link.previousElementSibling?.textContent === '🇺🇸 USA'));
  assert.deepEqual(f.calls.map(call => call.username).sort(),
    ['peterj_walker', 'openrouter', 'cartainc'].sort());
  assert.equal(f.rows[0].children.length, 2);
  assert.equal(f.rows[1].children.length, 2);
});

test('visible accounts are fetched before offscreen accounts in DOM order', async () => {
  const f = contentFixture({
    accounts: [
      { type: 'User-Name', handle: 'FarAway', name: 'Far Away', offscreen: true },
      { type: 'User-Name', handle: 'CloseBy', name: 'Close By' }
    ]
  });
  await waitFor(() => f.calls.length === 2);
  assert.deepEqual(f.calls.map(call => call.username), ['closeby', 'faraway']);
});

test('a newly visible account can overtake a full offscreen prefetch queue', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const accounts = Array.from({ length: 160 }, (_, index) => ({
    type: 'User-Name', handle: 'Person' + index,
    name: 'Person ' + index, offscreen: true
  }));
  const f = contentFixture({ accounts, lookup: () => pending });
  assert.equal(f.calls.length, 4);
  accounts[159].offscreen = false;
  f.listeners.get('scroll')();
  await new Promise(resolve => setTimeout(resolve, 120));
  finish({ success: true, country: 'Japan' });
  await waitFor(() => f.calls.length >= 5);
  assert.equal(f.calls[4].username, 'person159');
});


test('bio-only containers without account identity are not looked up', async () => {
  const f = contentFixture({
    accounts: [{ type: 'UserCell', handle: 'NoName', name: '',
      bio: ['OtherAccount'] }]
  });
  await waitFor(() => f.bioRows[0][0].link.previousElementSibling?.textContent === '🇯🇵 JPN');
  assert.deepEqual(f.calls.map(call => call.username), ['otheraccount']);
  assert.equal(f.rows[0].children.length, 1, 'no account identity badge');
});
