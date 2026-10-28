# Contributing

## Test

Run the Node tests and syntax checks for both extensions from the repository
root using Node.js 22 or newer:

```sh
npm test
```

For the X location-chip regression test in real Firefox:

```sh
npm ci
npx playwright install firefox
npm run test:firefox
```

CI runs this browser regression on both Linux and Windows and lints both
packaged extensions with `web-ext`.

## Release

Both extensions use the same unlisted Mozilla signing credentials and publish
signed `.xpi` files to GitHub Releases. The two add-ons have independent
versions and release tags:

| Extension | Manifest | Tag for version `1.2.3` |
| --- | --- | --- |
| X Account Location Flags | `extensions/x-account-location-flags/manifest.json` | `v1.2.3` |
| Reddit Direct Images | `extensions/reddit-direct-images/manifest.json` | `reddit-v1.2.3` |

Update the relevant manifest version, commit, and push the matching tag to
trigger `.github/workflows/release.yml`. The release workflow tests both
extensions, signs only the tagged extension, and attaches its signed `.xpi`
to a GitHub release.

The workflow rebuilds the shared
[Firefox update manifest](https://perennialtech.github.io/x-account-location-flags-firefox/updates.json)
from the latest signed release of **each** extension, then deploys it to
GitHub Pages. This preserves the update URL and signed-release history of X
Account Location Flags while allowing Reddit Direct Images to update
independently. Unsigned or draft releases are not published as updates.

The repository uses the GitHub Actions secrets `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET` to authenticate to
[Mozilla's unlisted signing service](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
Signing can fail or require Mozilla review; do not distribute an unsigned
package as a substitute.
