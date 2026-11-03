// Real Firefox/Gecko regression coverage for computed typography.
// Run after `npm ci` and `npx playwright install firefox`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { firefox } = require('playwright');

test('Firefox computes sans-serif fonts for all chip placements under serif parents',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <style>
        body, .serif-parent { font-family: Georgia, serif; }
        .display-name { font-family: Arial, sans-serif; }
      </style>
      <section data-testid="User-Name">
        <div id="regular" class="serif-parent">
          <a class="display-name" href="/Alice" role="link">Alice</a>
          <a href="/Alice" role="link" tabindex="-1">@Alice</a>
        </div>
      </section>
      <section data-testid="User-Name">
        <div id="quoted" class="serif-parent">
          <div class="display-name" dir="ltr">Carol</div>
          <div tabindex="-1">@Carol</div>
        </div>
      </section>
      <section data-testid="UserCell">
        <div id="user-cell" class="serif-parent">
          <a class="display-name" href="/Bob" role="link">Bob</a>
          <a href="/Bob" role="link" tabindex="-1">@Bob</a>
        </div>
        <div dir="auto"><span id="bio" class="serif-parent">
          <a href="/Dave" role="link">@Dave</a>
        </span></div>
      </section>
    `);
    // Execute the shipped content script against a real DOM, without an X login
    // or remote API calls. Only the extension's messaging boundary is mocked.
    await page.evaluate(() => {
      const locations = { alice: 'Japan', carol: 'East Asia', bob: 'Pakistan', dave: 'South Korea' };
      window.browser = { runtime: { sendMessage: async ({ username }) => ({
        success: true, country: locations[username], accurate: true
      }) } };
    });
    await page.addStyleTag({ path: path.join(__dirname, 'content.css') });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });

    const selectors = ['#regular', '#quoted', '#user-cell', '#bio'];
    await page.waitForFunction(selectors => selectors.every(selector =>
      document.querySelector(`${selector} > [data-x-account-flag="true"]`)), selectors);

    async function fontSnapshot() {
      return page.evaluate(selectors => selectors.map(selector => {
        const row = document.querySelector(selector);
        const chip = row.querySelector(':scope > [data-x-account-flag="true"]');
        return {
          parent: getComputedStyle(row).fontFamily,
          chip: getComputedStyle(chip).fontFamily
        };
      }), selectors);
    }

    function assertSansSerif(snapshot) {
      for (const { parent, chip } of snapshot) {
        assert.match(parent, /serif$/);
        assert.notEqual(chip, parent, 'chip must override its serif parent');
        assert.equal(chip.split(',').at(-1).trim(), 'sans-serif');
      }
    }

    assertSansSerif(await fontSnapshot());
    // Drain the scan scheduled by the initial DOM insertions, so the rescan
    // below is specifically triggered by our scroll event.
    await page.waitForTimeout(150);

    // Existing chips must be repaired on rescans as well as on first paint.
    await page.evaluate(selectors => {
      window.originalChips = selectors.map(selector =>
        document.querySelector(`${selector} > [data-x-account-flag="true"]`));
      window.originalChips.forEach(chip => { chip.style.fontFamily = 'serif'; });
    }, selectors);
    assert.deepEqual((await fontSnapshot()).map(({ chip }) => chip),
      Array(selectors.length).fill('serif'));
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForFunction(selectors => selectors.every(selector =>
      getComputedStyle(document.querySelector(`${selector} > [data-x-account-flag="true"]`))
        .fontFamily.split(',').at(-1).trim() === 'sans-serif'), selectors);
    assertSansSerif(await fontSnapshot());
    assert.equal(await page.evaluate(selectors => selectors.every((selector, i) =>
      document.querySelector(`${selector} > [data-x-account-flag="true"]`) ===
        window.originalChips[i]), selectors), true);
  });

test('Firefox renders location tags for mentions in a profile description',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <section>
        <div data-testid="UserName">
          <div id="owner-row"><div dir="ltr">dax</div></div>
          <div tabindex="-1"><div dir="ltr">@thdxr</div></div>
        </div>
        <div data-testid="UserDescription" style="width: 160px">
          <div dir="auto">
            building
            <div style="display: inline"><span id="opencode">
              <a href="/opencode" role="link">@opencode</a>
            </span></div>
            at <div style="display: inline"><span id="anomalyco">
              <a href="/anomalyco" role="link">@anomalyco</a>
            </span></div>
          </div>
        </div>
        <div data-testid="UserProfileHeader_Items">
          <a href="https://t.co/bWom5srB32" data-testid="UserUrl">thdxr.com</a>
        </div>
      </section>
    `);
    await page.evaluate(() => {
      const locations = { thdxr: 'United States', opencode: 'Japan', anomalyco: 'Pakistan' };
      window.lookupHandles = [];
      window.browser = { runtime: { sendMessage: async ({ username }) => {
        window.lookupHandles.push(username);
        return { success: true, country: locations[username], accurate: true };
      } } };
    });
    await page.addStyleTag({ path: path.join(__dirname, 'content.css') });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    await page.waitForFunction(() =>
      document.querySelector('#opencode > a > [data-x-account-flag="true"]') &&
      document.querySelector('#anomalyco > a > [data-x-account-flag="true"]') &&
      document.querySelector('#owner-row > [data-x-account-flag="true"]'));
    assert.deepEqual((await page.evaluate(() => window.lookupHandles)).sort(),
      ['thdxr', 'opencode', 'anomalyco'].sort());
    const snapshot = await page.evaluate(() => {
      const targets = ['#owner-row > [data-x-account-flag]',
        '#opencode > a > [data-x-account-flag]',
        '#anomalyco > a > [data-x-account-flag]'];
      window.originalChips = targets.map(selector => document.querySelector(selector));
      return window.originalChips.map(chip => ({
        text: chip.textContent,
        followedBy: chip.parentElement.tagName === 'A'
          ? chip.parentElement.textContent.replace(chip.textContent, '').trim()
          : chip.nextElementSibling.textContent.trim()
      }));
    });
    assert.deepEqual(snapshot, [
      { text: '🇺🇸 USA', followedBy: 'dax' },
      { text: '🇯🇵 JPN', followedBy: '@opencode' },
      { text: '🇵🇰 PAK', followedBy: '@anomalyco' }
    ]);
    assert.equal(await page.locator('[data-testid="UserUrl"] [data-x-account-flag]').count(), 0);
    const keepsMentionsTogether = await page.evaluate(() =>
      ['#opencode', '#anomalyco'].every(selector => {
        const mention = document.querySelector(`${selector} a[href]`);
        const chip = mention.querySelector('[data-x-account-flag]');
        const text = document.createRange();
        text.selectNodeContents(mention.lastChild);
        const a = chip.getBoundingClientRect();
        const b = text.getBoundingClientRect();
        return a.top < b.bottom && b.top < a.bottom;
      }));
    assert.equal(keepsMentionsTogether, true, 'tags must stay on the same line as mentions');
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => {
      const targets = ['#owner-row > [data-x-account-flag]',
        '#opencode > a > [data-x-account-flag]',
        '#anomalyco > a > [data-x-account-flag]'];
      return targets.every((selector, i) =>
        document.querySelectorAll(selector).length === 1 &&
        document.querySelector(selector) === window.originalChips[i]);
    }), true);
  });

test('Firefox preserves multiple profile mentions sharing an inline parent',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <div data-testid="UserDescription" style="width: 160px">
        <div dir="auto"><span id="mentions">
          <a href="/opencode" role="link">@opencode</a>
          and <a href="/anomalyco" role="link">@anomalyco</a>
        </span></div>
      </div>
    `);
    await page.evaluate(() => {
      window.browser = { runtime: { sendMessage: async ({ username }) => ({
        success: true, country: username === 'opencode' ? 'Japan' : 'Pakistan',
        accurate: true
      }) } };
    });
    await page.addStyleTag({ path: path.join(__dirname, 'content.css') });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    await page.waitForTimeout(450);
    const handles = () => page.locator('#mentions a > [data-x-account-flag]')
      .evaluateAll(nodes => nodes.map(node => node.dataset.xAccountHandle));
    assert.deepEqual(await handles(), ['opencode', 'anomalyco']);
    assert.equal(await page.evaluate(() => {
      const bio = document.querySelector('[data-testid="UserDescription"]');
      return bio.scrollWidth <= bio.clientWidth + 1;
    }), true, 'profile mentions should wrap without overflowing');
    await page.evaluate(() => {
      const links = document.querySelectorAll('#mentions a');
      links[1].href = '/opencode';
      links[1].lastChild.textContent = '@opencode';
    });
    await page.waitForFunction(() => {
      const chips = document.querySelectorAll('#mentions a > [data-x-account-flag]');
      return chips.length === 2 && [...chips].every(chip =>
        chip.dataset.xAccountHandle === 'opencode' && chip.textContent === '🇯🇵 JPN');
    });
    const originalChips = await page.locator('#mentions a > [data-x-account-flag]')
      .evaluateAll(nodes => nodes.map(node => node.textContent));
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(300);
    assert.deepEqual(await handles(), ['opencode', 'opencode']);
    assert.deepEqual(await page.locator('#mentions a > [data-x-account-flag]')
      .allTextContents(), originalChips);
    await page.evaluate(() => document.querySelector('#mentions a').remove());
    await page.waitForTimeout(150);
    assert.deepEqual(await handles(), ['opencode']);
    assert.equal(await page.locator('#mentions [data-x-account-flag]').count(), 1);
    await page.evaluate(() => document.querySelector('#mentions a').removeAttribute('href'));
    await page.waitForFunction(() =>
      document.querySelectorAll('#mentions [data-x-account-flag]').length === 0);
    assert.equal(await page.locator('#mentions [data-x-account-flag]').count(), 0);
  });

test('Firefox restores profile link styles and contains long annotated handles',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <div data-testid="UserDescription" style="width: 160px; font: 16px Arial">
        <span id="profile-bio">
          <a id="long" role="link" href="/abcdefghijklmno"
            style="color: rebeccapurple">@abcdefghijklmno</a>
        </span>
      </div>
    `);
    await page.evaluate(() => {
      window.browser = { runtime: { sendMessage: async () => ({
        success: true, country: 'Japan', accurate: true
      }) } };
    });
    await page.addStyleTag({ path: path.join(__dirname, 'content.css') });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const badge = '#long > [data-x-account-flag="true"]';
    await page.locator(badge).waitFor();
    assert.equal(await page.evaluate(() => {
      const bio = document.querySelector('[data-testid="UserDescription"]');
      return bio.scrollWidth <= bio.clientWidth + 1;
    }), true, 'a maximum-length username must not overflow the biography');
    assert.equal(await page.locator('#long').evaluate(link =>
      getComputedStyle(link).display), 'inline-flex');
    await page.evaluate(() => {
      const link = document.querySelector('#long');
      link.removeAttribute('href');
      link.lastChild.textContent = 'A longer ordinary description link with spaces';
    });
    await page.waitForFunction(() =>
      !document.querySelector('#long > [data-x-account-flag]'));
    const checkRestored = async () => {
      assert.deepEqual(await page.locator('#long').evaluate(link => ({
        display: link.style.display,
        whiteSpace: link.style.whiteSpace,
        alignItems: link.style.alignItems,
        maxWidth: link.style.maxWidth,
        overflowWrap: link.style.overflowWrap,
        color: link.style.color
      })), {
        display: '', whiteSpace: '', alignItems: '',
        maxWidth: '', overflowWrap: '', color: 'rebeccapurple'
      });
    };
    await checkRestored();
    assert.equal(await page.evaluate(() => {
      const bio = document.querySelector('[data-testid="UserDescription"]');
      return bio.scrollWidth <= bio.clientWidth + 1;
    }), true);
    await page.evaluate(() => {
      const link = document.querySelector('#long');
      link.href = '/abcdefghijklmno';
      link.lastChild.textContent = '@abcdefghijklmno';
    });
    await page.locator(badge).waitFor();
    await page.evaluate(() => {
      const link = document.querySelector('#long');
      link.style.setProperty('display', 'inline-grid', 'important');
      link.style.setProperty('white-space', 'pre-wrap', 'important');
      link.style.setProperty('max-width', '75%', 'important');
      link.lastChild.textContent = 'This is no longer an account mention';
    });
    await page.waitForFunction(() =>
      !document.querySelector('#long > [data-x-account-flag]'));
    assert.deepEqual(await page.locator('#long').evaluate(link => ({
      display: link.style.display,
      displayPriority: link.style.getPropertyPriority('display'),
      whiteSpace: link.style.whiteSpace,
      whiteSpacePriority: link.style.getPropertyPriority('white-space'),
      maxWidth: link.style.maxWidth,
      maxWidthPriority: link.style.getPropertyPriority('max-width'),
      color: link.style.color
    })), {
      display: 'inline-grid', displayPriority: 'important',
      whiteSpace: 'pre-wrap', whiteSpacePriority: 'important',
      maxWidth: '75%', maxWidthPriority: 'important', color: 'rebeccapurple'
    });
  });

test('Firefox contains long location labels and cleans up reused profile links',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const longLocation = 'Some Unknown Region with a Very Very Long Name';
    await page.setContent(`
      <div data-testid="UserDescription" style="width: 160px; font: 16px Arial">
        <div dir="auto" id="profile-bio">
          <a id="long-location" role="link" href="/abcdefghijklmno">@abcdefghijklmno</a>
          <a id="moved" role="link" href="/opencode"
            style="color: rebeccapurple; display: inline-block !important;
              white-space: pre-wrap !important">@opencode</a>
        </div>
      </div>
      <div data-testid="UserCell"><div id="cell-bio" dir="auto"></div></div>
    `);
    await page.evaluate(location => {
      window.browser = { runtime: { sendMessage: async ({ username }) => ({
        success: true, country: username === 'opencode' ? 'Japan' : location,
        accurate: true
      }) } };
    }, longLocation);
    await page.addStyleTag({ path: path.join(__dirname, 'content.css') });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    await page.waitForFunction(() =>
      document.querySelector('#long-location > [data-x-account-flag]') &&
      document.querySelector('#moved > [data-x-account-flag]'));
    assert.equal(await page.evaluate(() => {
      const bio = document.querySelector('[data-testid="UserDescription"]');
      return bio.scrollWidth <= bio.clientWidth + 1;
    }), true, 'unknown long location labels must not overflow narrow biographies');
    assert.equal(await page.locator('#long-location > [data-x-account-flag]')
      .getAttribute('title'), `Account based in ${longLocation} (according to X)`);
    await page.evaluate(() => {
      document.querySelector('#cell-bio').appendChild(document.querySelector('#moved'));
    });
    await page.waitForFunction(() =>
      document.querySelector('#cell-bio > [data-x-account-flag]') &&
      !document.querySelector('#moved > [data-x-account-flag]'));
    assert.equal(await page.locator('#cell-bio [data-x-account-flag]').count(), 1);
    assert.deepEqual(await page.locator('#moved').evaluate(link => ({
      display: link.style.getPropertyValue('display'),
      displayPriority: link.style.getPropertyPriority('display'),
      whiteSpace: link.style.getPropertyValue('white-space'),
      whiteSpacePriority: link.style.getPropertyPriority('white-space'),
      color: link.style.color
    })), {
      display: 'inline-block', displayPriority: 'important',
      whiteSpace: 'pre-wrap', whiteSpacePriority: 'important',
      color: 'rebeccapurple'
    });
  });

test('Firefox renders image-only account names on timeline, post and profile',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <section id="timeline" data-testid="User-Name">
        <div id="timeline-name-row">
          <a href="/_voltcrash" role="link"><div dir="ltr"><span>
            <img alt="⚡️" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
          </span></div></a>
        </div>
        <a href="/_voltcrash" role="link" tabindex="-1">
          <div dir="ltr">@_voltcrash</div>
        </a>
        <div id="timeline-time" dir="ltr">15h</div>
      </section>
      <section id="post" data-testid="User-Name">
        <div id="post-name-row">
          <a href="/_voltcrash" role="link"><div dir="ltr"><span>
            <img alt="⚡️" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
          </span></div></a>
        </div>
        <a href="/_voltcrash" role="link" tabindex="-1">
          <div dir="ltr">@_voltcrash</div>
        </a>
        <div dir="ltr">9:59 PM · Nov 2, 2026</div>
      </section>
      <section id="profile" data-testid="UserName">
        <div id="profile-name-row"><div dir="ltr"><span>
          <img alt="⚡️" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
        </span></div></div>
        <div tabindex="-1"><div dir="ltr">@_voltcrash</div></div>
      </section>
    `);
    await page.evaluate(() => {
      window.lookupHandles = [];
      window.browser = { runtime: { sendMessage: async ({ username }) => {
        window.lookupHandles.push(username);
        return { success: true, country: 'India', accurate: true };
      } } };
    });
    await page.addStyleTag({ path: path.join(__dirname, 'content.css') });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });

    const rows = ['#timeline-name-row', '#post-name-row', '#profile-name-row'];
    await page.waitForFunction(rows => rows.every(row =>
      document.querySelector(`${row} > [data-x-account-flag="true"]`)), rows);
    assert.deepEqual(await page.evaluate(rows => rows.map(row => {
      const nameRow = document.querySelector(row);
      const chip = nameRow.firstElementChild;
      return {
        text: chip.textContent,
        handle: chip.dataset.xAccountHandle,
        isFirst: chip.nextElementSibling?.querySelector('img')?.alt === '⚡️',
        count: nameRow.querySelectorAll('[data-x-account-flag="true"]').length
      };
    }), rows), rows.map(() => ({
      text: '🇮🇳 IND', handle: '_voltcrash', isFirst: true, count: 1
    })));
    assert.deepEqual(await page.evaluate(() => window.lookupHandles), ['_voltcrash']);
    assert.equal(await page.locator('#timeline-time [data-x-account-flag]').count(), 0);

    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(rows => rows.map(row =>
      document.querySelectorAll(`${row} > [data-x-account-flag="true"]`).length), rows),
    [1, 1, 1]);
  });

test('Firefox recognises keycap-only emoji image names in every header layout',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const linked = (id, emoji) => `
      <section data-testid="User-Name">
        <div id="${id}"><a href="/Alice" role="link">
          <div dir="ltr"><img alt="${emoji}"></div>
        </a></div>
        <a href="/Alice" role="link" tabindex="-1">@Alice</a>
      </section>`;
    await page.setContent(`
      ${linked('timeline-keycap', '1️⃣')}
      ${linked('post-keycap', '#️⃣')}
      <section data-testid="UserName">
        <div id="profile-keycap"><div dir="ltr"><img alt="*️⃣"></div></div>
        <div tabindex="-1"><div dir="ltr">@Alice</div></div>
      </section>
    `);
    await page.evaluate(() => {
      window.browser = { runtime: { sendMessage: async () => ({
        success: true, country: 'Japan', accurate: true
      }) } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const rows = ['#timeline-keycap', '#post-keycap', '#profile-keycap'];
    await page.waitForFunction(rows => rows.every(row =>
      document.querySelector(`${row} > [data-x-account-flag="true"]`)), rows);
    for (const row of rows) {
      assert.deepEqual(await page.locator(`${row} > [data-x-account-flag]`)
        .allTextContents(), ['🇯🇵 JPN']);
    }
  });

test('Firefox annotates public X name-handle pairs without data-testid containers',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    // Faithful to the public logged-out X layout: paired links within a div,
    // one for the name and one for the handle, with no role or tabindex.
    await page.setContent(`
      <section id="public-profile">
        <div id="profile-pair" class="flex items-center gap-1 min-w-0">
          <span id="profile-name" class="flex shrink-0">
            <a href="/_voltcrash" class="x-link">
              <div class="font-bold text-primary">⚡️</div>
            </a>
          </span>
          <span id="profile-handle" class="flex">
            <a href="/_voltcrash"><span>@_voltcrash</span></a>
          </span>
        </div>
      </section>
      <section id="public-post">
        <div class="flex gap-2">
          <a href="/_voltcrash"><div class="x-avatar"><img alt="⚡️"></div></a>
          <div id="post-pair" class="flex flex-col items-start">
            <span id="post-name"><a href="/_voltcrash" class="x-link">
              <div class="font-bold text-primary"><img alt="1️⃣"></div>
            </a></span>
            <span id="post-handle"><a href="/_voltcrash">
              <span>@_voltcrash</span>
            </a></span>
          </div>
        </div>
      </section>
      <div id="avatar-only">
        <span><a href="/Bob"><div class="x-avatar"><img alt="⚡️"></div></a></span>
        <span><a href="/Bob">@Bob</a></span>
      </div>
      <div id="bio"><a href="/Alice">@Alice</a></div>
      <a id="follow" aria-label="Follow" href="/_voltcrash">Follow</a>
    `);
    await page.evaluate(() => {
      window.lookupHandles = [];
      window.browser = { runtime: { sendMessage: async ({ username }) => {
        window.lookupHandles.push(username);
        return { success: true,
          country: username === 'alice' ? 'Japan' : 'India', accurate: true };
      } } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const profile = '#profile-name > [data-x-account-flag="true"]';
    const post = '#post-name > [data-x-account-flag="true"]';
    await page.waitForFunction(([a, b]) =>
      document.querySelector(a) && document.querySelector(b), [profile, post]);
    assert.equal(await page.locator(profile).textContent(), '🇮🇳 IND');
    assert.equal(await page.locator(post).textContent(), '🇮🇳 IND');
    for (const selector of ['#avatar-only', '#bio', '#follow', '#profile-handle', '#post-handle']) {
      assert.equal(await page.locator(`${selector} [data-x-account-flag]`).count(), 0);
    }
    assert.deepEqual(await page.evaluate(() => window.lookupHandles), ['_voltcrash']);

    // React may reuse a public-name row for a different account.
    await page.evaluate(() => {
      document.querySelector('#profile-name a').href = '/Alice';
      document.querySelector('#profile-name a div').textContent = 'Alice';
      document.querySelector('#profile-handle a').href = '/Alice';
      document.querySelector('#profile-handle a span').textContent = '@Alice';
    });
    await page.waitForFunction(selector => {
      const chip = document.querySelector(selector);
      return chip?.dataset.xAccountHandle === 'alice' && chip.textContent === '🇯🇵 JPN';
    }, profile);
    assert.equal(await page.locator(post).textContent(), '🇮🇳 IND');
    assert.deepEqual(await page.locator('#profile-name [data-x-account-flag]')
      .allTextContents(), ['🇯🇵 JPN']);
    assert.deepEqual(await page.evaluate(() => window.lookupHandles), ['_voltcrash', 'alice']);
  });

test('Firefox annotates the plain-text main header of a public X profile',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    // Use a fulfilled X URL to exercise route scoping without remote traffic.
    await page.route('https://x.com/_voltcrash', route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: `
        <header id="public-profile-main">
          <div class="min-w-0 flex flex-col items-start">
            <span id="main-name"><h1 class="text-headline1">⚡️</h1></span>
            <span><span id="main-handle">@_voltcrash</span></span>
          </div>
        </header>
        <h1 id="login-heading">Log in or sign up for X</h1>
        <div id="stray-handle"><span>@Alice</span></div>
      `
    }));
    await page.goto('https://x.com/_voltcrash');
    await page.evaluate(() => {
      window.lookupHandles = [];
      window.browser = { runtime: { sendMessage: async ({ username }) => {
        window.lookupHandles.push(username);
        return { success: true,
          country: username === '_voltcrash' ? 'India' : 'Japan', accurate: true };
      } } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const badge = '#main-name > [data-x-account-flag="true"]';
    await page.locator(badge).waitFor();
    assert.equal(await page.locator(badge).textContent(), '🇮🇳 IND');
    assert.equal(await page.locator('#main-name > [data-x-account-flag]').count(), 1);
    assert.equal(await page.locator('#login-heading [data-x-account-flag]').count(), 0);
    assert.equal(await page.locator('#stray-handle [data-x-account-flag]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.lookupHandles), ['_voltcrash']);

    // An image-only keycap name is still a valid main-profile display name.
    await page.evaluate(() => {
      document.querySelector('#main-name h1').innerHTML = '<img alt="1️⃣">';
    });
    await page.waitForTimeout(200);
    assert.deepEqual(await page.locator('#main-name > [data-x-account-flag]')
      .allTextContents(), ['🇮🇳 IND']);

    // A client-side navigation must not leave the old account's badge behind.
    await page.evaluate(() => {
      history.pushState({}, '', '/Alice');
      document.querySelector('#main-handle').textContent = '@Alice';
    });
    await page.waitForFunction(selector => {
      const chip = document.querySelector(selector);
      return chip?.dataset.xAccountHandle === 'alice' && chip.textContent === '🇯🇵 JPN';
    }, badge);
    assert.deepEqual(await page.locator('#main-name > [data-x-account-flag]')
      .allTextContents(), ['🇯🇵 JPN']);
    assert.deepEqual(await page.evaluate(() => window.lookupHandles),
      ['_voltcrash', 'alice']);
  });

test('Firefox prefers the account name over avatar and unrelated image links',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <section data-testid="UserCell" id="alice">
        <div id="avatar-row"><a href="/Alice" role="link"><img alt="Profile photo"></a></div>
        <div id="alice-name"><a href="/Alice" role="link">Alice</a></div>
        <a href="/Alice" role="link" tabindex="-1">@Alice</a>
      </section>
      <section data-testid="UserCell" id="avatar-only">
        <div data-testid="UserAvatar-Container-Bob">
          <a href="/Bob" role="link"><img alt="Profile photo"></a>
        </div>
        <a href="/Bob" role="link" tabindex="-1">@Bob</a>
      </section>
      <section data-testid="UserName" id="profile">
        <div id="misc-row"><div dir="ltr"><img alt="Unrelated icon"></div></div>
        <div id="profile-name"><div dir="ltr"><img alt="⚡️"></div></div>
        <div tabindex="-1"><div dir="ltr">@_voltcrash</div></div>
      </section>
    `);
    await page.evaluate(() => {
      window.lookupHandles = [];
      window.browser = { runtime: { sendMessage: async ({ username }) => {
        window.lookupHandles.push(username);
        return { success: true, country: 'India', accurate: true };
      } } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    await page.waitForFunction(() =>
      document.querySelector('#alice-name > [data-x-account-flag]') &&
      document.querySelector('#profile-name > [data-x-account-flag]'));
    assert.equal(await page.locator('#avatar-row [data-x-account-flag]').count(), 0);
    assert.equal(await page.locator('#avatar-only [data-x-account-flag]').count(), 0);
    assert.equal(await page.locator('#misc-row [data-x-account-flag]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.lookupHandles.sort()),
      ['_voltcrash', 'alice']);
  });

test('Firefox reconciles reused name rows and observes emoji alt changes',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <section data-testid="User-Name">
        <div id="name-row"><a id="name" href="/Alice" role="link">
          <div dir="ltr"><img id="emoji" alt="⚡️"></div>
        </a></div>
        <a id="handle" href="/Alice" role="link" tabindex="-1">
          <div dir="ltr">@Alice</div>
        </a>
      </section>
    `);
    await page.evaluate(() => {
      window.lookupHandles = [];
      window.browser = { runtime: { sendMessage: async ({ username }) => {
        window.lookupHandles.push(username);
        return { success: true,
          country: username === 'alice' ? 'India' : 'Japan', accurate: true };
      } } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const selector = '#name-row > [data-x-account-flag="true"]';
    await page.locator(selector).waitFor();
    assert.equal(await page.locator(selector).textContent(), '🇮🇳 IND');

    // React may reuse the element while the new account has no display name.
    await page.evaluate(() => {
      document.querySelector('#name').setAttribute('href', '/Bob');
      document.querySelector('#handle').setAttribute('href', '/Bob');
      document.querySelector('#handle div').textContent = '@Bob';
      document.querySelector('#emoji').alt = '';
    });
    await page.waitForFunction(() =>
      !document.querySelector('#name-row > [data-x-account-flag]'));
    assert.equal(await page.locator(selector).count(), 0);

    // An alt-only update must be sufficient to discover the new display name.
    await page.evaluate(() => { document.querySelector('#emoji').alt = '⚡️'; });
    await page.waitForFunction(() =>
      document.querySelector('#name-row > [data-x-account-flag]')?.textContent === '🇯🇵 JPN');
    assert.deepEqual(await page.evaluate(() => window.lookupHandles), ['alice', 'bob']);

    await page.evaluate(() => { document.querySelector('#emoji').alt = ''; });
    await page.waitForFunction(() =>
      !document.querySelector('#name-row > [data-x-account-flag]'));
    assert.equal(await page.locator(selector).count(), 0);
  });

test('Firefox keeps UserCell header badges out of same-account biography links',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <section data-testid="UserCell">
        <div id="name-row"><a href="/Alice" role="link">Alice</a></div>
        <div><a href="/Alice" role="link" tabindex="-1">@Alice</a></div>
        <div dir="auto" id="bio"><a href="/Alice" role="link">
          Read Alice's posts</a></div>
      </section>
    `);
    await page.evaluate(() => {
      window.browser = { runtime: { sendMessage: async () => ({
        success: true, country: 'India', accurate: true
      }) } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    await page.locator('#name-row > [data-x-account-flag]').waitFor();
    assert.equal(await page.locator('#name-row > [data-x-account-flag]').textContent(),
      '🇮🇳 IND');
    assert.equal(await page.locator('#bio [data-x-account-flag]').count(), 0);
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#name-row > [data-x-account-flag]').count(), 1);
    assert.equal(await page.locator('#bio [data-x-account-flag]').count(), 0);
  });

test('Firefox keeps quoted-post name badges ahead of affiliation images',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <section data-testid="User-Name" id="text-name">
        <div id="true-name"><div dir="ltr">Alice</div></div>
        <div id="affiliation"><div dir="ltr">
          <img alt="Affiliated with ExampleCorp"></div></div>
        <div tabindex="-1"><div dir="ltr">@Alice</div></div>
      </section>
      <section data-testid="User-Name" id="image-name">
        <div id="unrelated"><div dir="ltr"><img alt="Unrelated icon"></div></div>
        <div id="emoji-name"><div dir="ltr"><img alt="⚡️"></div></div>
        <div id="second-affiliation"><div dir="ltr">
          <img alt="Affiliated with ExampleCorp"></div></div>
        <div id="text-affiliation"><div dir="ltr">ExampleCorp affiliated</div></div>
        <div tabindex="-1"><div dir="ltr">@_voltcrash</div></div>
      </section>
    `);
    await page.evaluate(() => {
      window.browser = { runtime: { sendMessage: async ({ username }) => ({
        success: true, country: username === 'alice' ? 'Japan' : 'India',
        accurate: true
      }) } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    await page.waitForFunction(() =>
      document.querySelector('#true-name > [data-x-account-flag]') &&
      document.querySelector('#emoji-name > [data-x-account-flag]'));
    assert.equal(await page.locator('#true-name > [data-x-account-flag]').textContent(),
      '🇯🇵 JPN');
    assert.equal(await page.locator('#emoji-name > [data-x-account-flag]').textContent(),
      '🇮🇳 IND');
    for (const selector of ['#affiliation', '#unrelated', '#second-affiliation', '#text-affiliation']) {
      assert.equal(await page.locator(selector + ' [data-x-account-flag]').count(), 0);
    }
  });

test('Firefox ignores emoji-bearing avatar and affiliation decorations before names',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <section data-testid="UserName">
        <div id="avatar-row" class="user-avatar"><div dir="ltr">
          <img alt="⚡️"></div></div>
        <div id="real-name"><div dir="ltr">Alice</div></div>
        <div tabindex="-1"><div dir="ltr">@Alice</div></div>
      </section>
      <section data-testid="User-Name">
        <div id="quote-row"><div dir="ltr">
          <img alt="✨ affiliation"></div></div>
        <div id="tweet-name"><div dir="ltr">Bob</div></div>
        <div tabindex="-1"><div dir="ltr">@Bob</div></div>
      </section>
      <section data-testid="User-Name">
        <div id="affiliation-icon" data-testid="AffiliationBadge"><div dir="ltr">
          <img alt="✨"></div></div>
        <div id="emoji-real-name"><div dir="ltr"><img alt="⚡️"></div></div>
        <div tabindex="-1"><div dir="ltr">@Carol</div></div>
      </section>
    `);
    await page.evaluate(() => {
      window.browser = { runtime: { sendMessage: async () => ({
        success: true, country: 'Japan', accurate: true
      }) } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const expected = ['#real-name', '#tweet-name', '#emoji-real-name'];
    await page.waitForFunction(rows => rows.every(row =>
      document.querySelector(`${row} > [data-x-account-flag="true"]`)), expected);
    for (const id of expected) {
      assert.deepEqual(await page.locator(`${id} > [data-x-account-flag]`)
        .allTextContents(), ['🇯🇵 JPN']);
    }
    for (const id of ['#avatar-row', '#quote-row', '#affiliation-icon']) {
      assert.equal(await page.locator(`${id} [data-x-account-flag]`).count(), 0);
    }
  });

test('Firefox restores original header row layout when chips disappear',
  { timeout: 30_000 }, async t => {
    const browser = await firefox.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`
      <section data-testid="User-Name">
        <div id="row" style="flex-direction: column; align-items: flex-end">
          <a id="name" href="/Alice" role="link"><div dir="ltr">Alice</div></a>
        </div>
        <a href="/Alice" role="link" tabindex="-1">@Alice</a>
      </section>
    `);
    await page.evaluate(() => {
      window.browser = { runtime: { sendMessage: async () => ({
        success: true, country: 'Japan', accurate: true
      }) } };
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const badge = '#row > [data-x-account-flag]';
    await page.locator(badge).waitFor();
    assert.deepEqual(await page.locator('#row').evaluate(row => ({
      flex: row.style.flexDirection, align: row.style.alignItems
    })), { flex: 'row', align: 'center' });

    await page.evaluate(() => document.querySelector('#name').removeAttribute('href'));
    await page.waitForFunction(() => !document.querySelector('#row [data-x-account-flag]'));
    assert.deepEqual(await page.locator('#row').evaluate(row => ({
      flex: row.style.flexDirection, align: row.style.alignItems
    })), { flex: 'column', align: 'flex-end' });

    await page.evaluate(() => document.querySelector('#name').href = '/Alice');
    await page.locator(badge).waitFor();
    assert.deepEqual(await page.locator('#row').evaluate(row => ({
      flex: row.style.flexDirection, align: row.style.alignItems
    })), { flex: 'row', align: 'center' });
    await page.evaluate(() => document.querySelector('#name').removeAttribute('href'));
    await page.waitForFunction(() => !document.querySelector('#row [data-x-account-flag]'));
    assert.deepEqual(await page.locator('#row').evaluate(row => ({
      flex: row.style.flexDirection, align: row.style.alignItems
    })), { flex: 'column', align: 'flex-end' });
  });
