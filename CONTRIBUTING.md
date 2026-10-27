# Contributing

## Test

With Node.js 22 (the version used in CI), run from the repository root:

```sh
node --check background.js
node --check content.js
node --test test.js
```

The tests mock FxTwitter and X's DOM. Also [load the extension temporarily in
Firefox](README.md#install-temporarily-for-development) and check that location
chips display in posts and user lists before distributing changes.

For the real Firefox regression test (computed chip fonts under serif-styled
parents, including chip reuse after rescanning), run:

```sh
npm ci
npx playwright install firefox
npm run test:firefox
```

This test executes the actual `content.js` against a real Firefox DOM with
mocked location responses. CI runs it on both Linux and Windows.

## Distribution

The [release workflow](.github/workflows/release.yml) tests the extension,
submits it to Mozilla for [unlisted signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/),
attaches the signed `.xpi` to a GitHub release, and deploys a Firefox update
manifest to GitHub Pages. Only completed, signed releases are advertised.

Configure the GitHub Actions secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`
using [Mozilla API credentials](https://addons.mozilla.org/developers/addon/api/key/).
Update `manifest.json` to the intended version, commit the changes, and push
the matching `v<version>` tag. The tag must point to the release commit.
Signing can fail or require Mozilla review; do not distribute an unsigned
package as a substitute.
