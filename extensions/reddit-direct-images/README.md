# Reddit Direct Images

A Firefox extension that restores direct Reddit image URLs.

Reddit serves an HTML media page when a browser navigates to an image URL
with `Accept: text/html`. This extension changes that header to accept images
for top-level navigations to `i.redd.it`, `preview.redd.it`,
`cf.preview.redd.it`, and `external-preview.redd.it`. It also unwraps
`reddit.com/media?url=...` links pointing to those hosts.

It does not alter images embedded in Reddit pages, normal Reddit browsing,
image quality settings, or image URL parameters.

## Install

Download the signed `.xpi` from the [Reddit Direct Images releases](https://github.com/perennialtech/firefox-extensions/releases?q=reddit-v)
when a signed release is available. In Firefox, open `about:addons`, select
the gear menu, and choose **Install Add-on From File**.

For temporary installation during development:

1. Clone or download the repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Select **Load Temporary Add-on** and choose
   `extensions/reddit-direct-images/manifest.json`.

Temporary add-ons are removed when Firefox exits. Permanent installation in
standard Firefox requires a signed `.xpi`.

## Verify

Open a `preview.redd.it` or `i.redd.it` image URL directly in Firefox. The
address bar should keep the image URL and Firefox should display the image
without navigating to `www.reddit.com/media`.

Run `npm test` from the repository root to exercise request and redirect logic.
