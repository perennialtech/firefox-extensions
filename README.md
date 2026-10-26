# X Account Location Flags for Firefox

A small Firefox extension that displays X's **Account based in** metadata
before display names in timelines, replies and user lists. Countries and
territories appear as a flag (when supported by the system) and an ISO 3166-1
alpha-3 code (for example, 🇯🇵 JPN). Geographic regions have short labels (for
example, SE Asia or LATAM). Both use square, content-sized light chips inline
with the account name, including user lists and quoted posts. No placeholder is
shown while the location is loading. Data comes from
[FxTwitter](https://docs.fxembed.com/api/twitter/operations/2profilehandleabout/).
It does not prove a person's real-world location.

## Install temporarily

1. Open `about:debugging#/runtime/this-firefox` in Firefox 128 or newer.
2. Choose **Load Temporary Add-on** and select `manifest.json`.
3. Open https://x.com/ and refresh the page.

For permanent installation in standard Firefox, package and sign the extension.

## Design

- **`content.js`** identifies handles and displays country codes or region labels
  before X's display names (without changing profile links). Quoted posts with
  text-only name/handle elements are supported. UserCell card biographies retain
  inline location annotations for their @mentions. It prefetches DOM-mounted
  accounts, prioritizing visible rows and pointer/keyboard focus. Cached flags
  are rendered immediately. It makes no HTTP requests itself.
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
and X. Country identifiers follow [ISO 3166-1](https://www.iso.org/iso-3166-country-codes.html),
using the [iso-codes dataset](https://salsa.debian.org/iso-codes-team/iso-codes).
Region identifiers and English names follow [Unicode CLDR](https://cldr.unicode.org/)
via `Intl.DisplayNames`; a small set of display abbreviations is curated locally.
Non-ISO territories and unrecognized location values remain as text rather than
being assigned invented alpha-3 codes or misleading country flags.

## Test

`node --check background.js && node --check content.js && node --test test.js`

These tests exercise the background and content scripts against a mocked
FxTwitter API and DOM. They do not substitute for manually testing in Firefox.
