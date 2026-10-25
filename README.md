# X Account Location Flags for Firefox

A small, dependency-free Firefox extension showing an account's X **Account based in** country as a flag beside its handle. X's metadata is not an independently verified physical location.

## Install (temporary)

1. Open about:debugging#/runtime/this-firefox in Firefox 128 or newer.
2. Choose Load Temporary Add-on and select manifest.json.
3. Log in to x.com and refresh the page.

Temporary add-ons are removed when Firefox restarts. Permanent Firefox installation requires signing.

## How it works

- The MAIN-world page.js captures X's authorization header from either fetch or XMLHttpRequest. It reads the ct0 CSRF cookie when making lookups. Neither secret is sent to the isolated content script or persisted.
- The isolated content.js detects account handles, queues lookups at a three-second minimum interval, and draws flags.
- AboutAccountQuery requests use the current X session. The native query ID is learned when visible, with two known IDs as fallbacks if the first is missing.
- Successful country results are cached locally for 30 days; successful empty results for six hours. Transient errors are not persisted.
- HTTP 429, or a zero remaining request budget, pauses lookups until the API resets.

## Limitations

- Requires a logged-in X session with normal authenticated GraphQL traffic.
- X may change its unofficial API, schemas, or rate limits without warning.
- Heavy use can exhaust X's shared AboutAccountQuery budget, potentially affecting its own About this account panel. Avoid needless refreshing.
- Accounts without a country, including some region-only accounts, do not get a national flag.

## Tests

Run: node --check page.js && node --check content.js && node --test test.js

The tests use mocked responses and do not substitute for a live, signed-in Firefox check.
