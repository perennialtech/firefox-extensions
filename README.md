# X Account Location Flags for Firefox

A small Firefox extension that displays X's **Account based in** metadata
beside handles in timelines, replies and user lists. Countries appear as flags;
larger geographic regions (for example, East Asia) appear as muted text on
the same line as the handle and timestamp. Data comes from
[FxTwitter](https://docs.fxembed.com/api/twitter/operations/2profilehandleabout/).
It does not prove a person's real-world location.

## Install temporarily

1. Open `about:debugging#/runtime/this-firefox` in Firefox 128 or newer.
2. Choose **Load Temporary Add-on** and select `manifest.json`.
3. Open https://x.com/ and refresh the page.

For permanent installation in standard Firefox, package and sign the extension.

## Design

- **`content.js`** identifies handles and displays flags or region names as
  separate flex-row siblings of X's handle wrapper (never inside its link).
  It only looks up accounts
  presently visible on the page, giving pointer/keyboard focus priority. Cached
  flags are rendered immediately. It makes no HTTP requests itself.
- **`background.js`** requests
  `GET https://api.fxtwitter.com/2/profile/{handle}/about` using the Firefox
  host permission. It does not call X, intercept X requests, read X cookies,
  or access X credentials. The background script validates handles and
  deduplicates overlapping lookups across tabs.
- All metadata is stored in Firefox's local extension storage only. Known
  locations expire after 14 days; successful responses with no location after
  12 hours. Network errors aren't persisted. FxTwitter 429 responses pause
  outgoing requests, respecting `Retry-After` where provided.
- Calls are limited to four concurrent requests, started at least 200 ms apart.
  The extension neither requires an X login nor sends credentials to FxTwitter.

## Privacy and limitations

Looking up an account sends its public handle to FxTwitter, alongside normal
HTTP request metadata such as your network IP. No other account information,
X cookies, or X authorization headers are transmitted. FxTwitter is an
independent service, and its availability and accuracy depend on both FxTwitter
and X. Unknown location values are displayed as text rather than being
silently dropped or misrepresented as country flags.

## Test

`node --check background.js && node --check content.js && node --test test.js`

These tests exercise the background and content scripts against a mocked
FxTwitter API and DOM. They do not substitute for manually testing in Firefox.
