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
