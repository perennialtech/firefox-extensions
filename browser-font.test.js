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
