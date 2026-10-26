# Contributing

## Test

With Node.js 22 (the version used in CI), run from the repository root:

```sh
node --check background.js
node --check content.js
node --test test.js
```

The tests mock FxTwitter and X's DOM. Also [load the extension temporarily in
Firefox](README.md#install-temporarily) and check that location chips display in
posts and user lists before distributing changes.

## Distribution

Standard Firefox requires a Mozilla-signed add-on package for permanent
installation. Follow [Mozilla's signing and distribution guide](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
to package the extension and submit it for signing. This repository has no
automated distribution process.
