# X Account Location Flags for Firefox

A Firefox extension that shows X's **Account based in** metadata before account
names in posts, replies and user lists (including quoted posts). Countries and
territories appear with a flag, when supported by the system, and an ISO 3166-1
alpha-3 code (such as 🇯🇵 JPN); geographic regions use short labels (such as
SE Asia or LATAM). Southern Asia and its countries use pale red chips.

Locations come from [FxTwitter](https://docs.fxembed.com/api/twitter/operations/2profilehandleabout/)
and **do not establish where a person actually lives or is currently located**.

## Install

You need Firefox 140 or newer.

1. Download the signed `.xpi` from a release tagged `v<version>` in the
   [GitHub releases](https://github.com/perennialtech/x-account-location-flags-firefox/releases?q=v).
   Releases tagged `reddit-v<version>` are for a different extension.
2. Open `about:addons` in Firefox, select the gear menu, and choose **Install Add-on From File**.
3. Select the downloaded `.xpi`, then open or refresh [X](https://x.com/).

The signed extension stays installed after Firefox restarts. Starting with
version 0.2.0, Firefox can update it automatically from GitHub Releases using
the [update manifest](https://perennialtech.github.io/x-account-location-flags-firefox/updates.json).
If you installed an earlier version, install 0.2.0 manually once to enable updates.

## Install temporarily for development

1. From the [repository](https://github.com/perennialtech/x-account-location-flags-firefox), select **Code → Download ZIP** and extract it.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose `manifest.json` in the extracted folder.
4. Open or refresh [X](https://x.com/). Accounts with available location metadata
   should show a chip before their display name; the first lookup can take a moment.

Temporary extensions are removed when Firefox restarts.

## Troubleshooting

- **No chips appear:** Check that the add-on is loaded in `about:debugging`,
  then refresh X. Individual accounts may have no location metadata.
- **Chips are delayed or missing for many accounts:** Lookups depend on FxTwitter.
  If it is unavailable or rate-limiting requests, try again later.

## Privacy and limitations

Looking up an account sends its public handle to FxTwitter, along with normal
request metadata such as your IP address. The extension does not send X cookies,
credentials or authorization headers to FxTwitter, and does not require an X
login of its own. Lookup results are cached in Firefox's local extension storage.

Country names and codes use [ISO 3166-1](https://www.iso.org/iso-3166-country-codes.html)
and English names from [Unicode CLDR](https://cldr.unicode.org/), with common
name variants supported. Unrecognized locations remain as text instead of being
assigned an invented country flag or code. The accuracy and availability of
reported locations depend on X and FxTwitter.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for testing and distribution guidance.
