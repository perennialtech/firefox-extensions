# Reddit Direct Images

A small Firefox extension that restores direct Reddit image URLs.

Reddit serves an HTML media page when a browser navigates to an image URL
with `Accept: text/html`. This extension changes that header to accept images
for top-level navigations to `i.redd.it`, `preview.redd.it`,
`cf.preview.redd.it`, and `external-preview.redd.it`. It also unwraps
`reddit.com/media?url=...` links pointing to those hosts.

It does not alter images embedded in Reddit pages, normal Reddit browsing,
image quality settings, or image URL parameters.

## Install in Firefox

1. Clone or download this repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**, then select `manifest.json`.

Temporary add-ons are removed when Firefox exits. For permanent installation
in standard Firefox, Mozilla requires a signed add-on; this repository does
not contain a signed XPI.

## Verify

Open a `preview.redd.it` or `i.redd.it` image URL directly in Firefox. The
address bar should keep the image URL and Firefox should display the image
without navigating to `www.reddit.com/media`.

Run `node --test` to exercise the request and redirect logic.
