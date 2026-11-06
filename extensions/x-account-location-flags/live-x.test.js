const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Builder, By } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');

test('signed-in Firefox renders a location chip on the live X profile',
  { timeout: 120_000 }, async t => {
    const authToken = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;
    assert.ok(authToken && ct0, 'X_AUTH_TOKEN and X_CT0 are required');

    const driver = await new Builder().forBrowser('firefox')
      .setFirefoxOptions(new firefox.Options().addArguments('-headless'))
      .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access'))
      .build();
    t.after(() => driver.quit());
    await driver.manage().window().setRect({ width: 1280, height: 900 });

    // A temporary installation exercises the real content script and
    // background requests without depending on Mozilla add-on signing.
    const extension = await driver.installWebExtension(__dirname, { permanent: false });

    // Configure the installed add-on before opening X so the test cannot
    // change the account's block list through suggested profiles.
    await driver.setContext(firefox.Context.CHROME);
    let extensionUuids;
    try {
      extensionUuids = JSON.parse(await driver.executeScript(
        'return Services.prefs.getStringPref("extensions.webextensions.uuids")'));
    } finally {
      await driver.setContext(firefox.Context.CONTENT);
    }
    const uuid = extensionUuids[extension.id];
    assert.ok(uuid, 'Firefox did not assign an extension origin');
    await driver.get(`moz-extension://${uuid}/options.html`);
    const blockingDisabled = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.set({ autoBlockSouthAsia: false, autoBlockUncertain: false })
        .then(() => browser.storage.local.get(['autoBlockSouthAsia', 'autoBlockUncertain']))
        .then(settings => done(settings.autoBlockSouthAsia === false &&
          settings.autoBlockUncertain === false))
        .catch(() => done(false));
    `);
    assert.equal(blockingDisabled, true, 'automatic blocking must be disabled for CI');

    await driver.get('https://x.com/github');
    for (const [name, value] of [['auth_token', authToken], ['ct0', ct0]]) {
      await driver.manage().addCookie({
        name, value, path: '/', secure: true, sameSite: 'Lax',
        httpOnly: name === 'auth_token'
      });
    }
    await driver.navigate().refresh();

    assert.equal(await driver.executeScript(
      'return document.cookie.split("; ").some(cookie => cookie.startsWith("auth_token="))'),
    false, 'the X session token must not be readable by page scripts');

    try {
      await driver.wait(async () =>
        (await driver.findElements(By.css('[data-testid="SideNav_AccountSwitcher_Button"]')))
          .length > 0, 30_000, 'the X test account did not sign in');
    } catch (error) {
      // Only report known page states. Never dump page content, URLs with
      // query strings, cookies, or screenshots from an authenticated browser.
      const state = await driver.executeScript(`
        const text = document.body?.innerText || '';
        return {
          host: location.hostname,
          route: location.pathname === '/github' ? 'profile' :
            location.pathname.startsWith('/i/flow/login') ? 'login' :
            location.pathname.startsWith('/account/access') ? 'account-access' : 'other',
          readyState: document.readyState,
          mainColumn: !!document.querySelector('[data-testid="primaryColumn"]'),
          profileHeader: !!document.querySelector('[data-testid="UserName"]'),
          loginForm: !!document.querySelector('input[autocomplete="username"]'),
          loginLink: !!document.querySelector('a[href*="/i/flow/login"]'),
          challenge: /verify (you are human|your identity)|unusual activity|just a moment/i.test(text),
          loginPrompt: /log in to x|sign in to x|sign in to twitter/i.test(text),
          siteError: /something went wrong|try again later|temporarily unavailable/i.test(text)
        };
      `).catch(() => ({ browserState: 'unavailable' }));
      const cookieNames = (await driver.manage().getCookies()).map(cookie => cookie.name);
      throw new Error('X did not show the signed-in UI: ' +
        JSON.stringify({ ...state,
          authCookiePresent: cookieNames.includes('auth_token'),
          csrfCookiePresent: cookieNames.includes('ct0') }),
      { cause: error });
    }

    const badgeSelector = '[data-x-account-flag="true"][data-x-account-handle="github"]';
    await driver.wait(async () =>
      (await driver.findElements(By.css(badgeSelector))).length > 0,
    30_000, 'the extension did not render a location chip');

    const badge = await driver.findElement(By.css(badgeSelector));
    assert.match(await badge.getText(), /\bUSA\b/);
    assert.match(await badge.getAttribute('aria-label'), /^Account based in United States/);
  });
