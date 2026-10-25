# X Account Location Flags for Firefox

A small, dependency-free Firefox extension that shows a country flag beside X/Twitter account handles in timelines, replies, and profile-related views. Based on [RhysSullivan/twitter-account-location-in-username](https://github.com/RhysSullivan/twitter-account-location-in-username), rewritten for Firefox rather than porting the Chrome extension wholesale.

It uses the **account based in** value returned by X's `AboutAccountQuery`, not a user's freely editable profile location. This is account-level metadata, not a precise or independently verified geographic location.

## Install (temporary)

1. In Firefox 128 or newer, open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select `manifest.json` from this folder.
3. Log in to https://x.com/ and refresh the page.

Temporary add-ons are removed when Firefox restarts. Permanent installation requires a Firefox-signed add-on package (including for personal distribution in standard Firefox).

## How it works

- `page.js` runs in Firefox's `MAIN` content-script world before X starts. It observes the authorization headers on X's *own* GraphQL requests, then makes authenticated same-origin `AboutAccountQuery` requests. Headers stay in that page context.
- `content.js` runs in Firefox's isolated content-script world. It detects `@handles` in X's username components, queues lookups (one every two seconds), and displays the returned flags.
- Successful results are cached locally for seven days. Only country metadata is stored, not authentication headers.
- No backend, build tools, third-party dependencies, or additional host permissions.

## Limitations

- Requires a logged-in session and an X GraphQL request from which the extension can observe the necessary authentication headers.
- X can change its private endpoint, response schema, authentication, or page markup without notice.
- Some accounts don't expose an `account based in` value; those accounts won't get a flag.
- Requests may be rate-limited. A 429 response pauses requests until the API's reset time (or 15 minutes if absent).
- Firefox's MAIN execution world is available from Firefox 128 onward.

## Testing

Run `node --check page.js && node --check content.js && node test.js` for syntax and a mocked end-to-end check. Load the unpacked extension in Firefox and check a logged-in X timeline to exercise the real API and DOM integration.
