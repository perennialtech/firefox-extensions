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
      .setFirefoxOptions(new firefox.Options().addArguments('-headless')).build();
    t.after(() => driver.quit());
    await driver.manage().window().setRect({ width: 1280, height: 900 });

    // A temporary installation exercises the real content script and
    // background requests without depending on Mozilla add-on signing.
    await driver.installWebExtension(__dirname, { permanent: false });

    // Use a non-South-Asian profile to avoid the extension's optional
    // automatic blocking changing the test account's block list.
    await driver.get('https://x.com/github');
    for (const [name, value] of [['auth_token', authToken], ['ct0', ct0]]) {
      await driver.manage().addCookie({ name, value, path: '/', secure: true });
    }
    await driver.navigate().refresh();

    await driver.wait(async () =>
      (await driver.findElements(By.css('[data-testid="SideNav_AccountSwitcher_Button"]')))
        .length > 0, 30_000, 'the X test account did not sign in');

    const badgeSelector = '[data-x-account-flag="true"][data-x-account-handle="github"]';
    await driver.wait(async () =>
      (await driver.findElements(By.css(badgeSelector))).length > 0,
    30_000, 'the extension did not render a location chip');

    const badge = await driver.findElement(By.css(badgeSelector));
    assert.match(await badge.getText(), /\bUSA\b/);
    assert.match(await badge.getAttribute('aria-label'), /^Account based in United States/);
  });
