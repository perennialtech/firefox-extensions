const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const listeners = {};
const webRequest = {
  onBeforeSendHeaders: {
    addListener(handler, filter, options) {
      listeners.headers = { handler, filter, options };
    },
  },
  onBeforeRequest: {
    addListener(handler, filter, options) {
      listeners.redirect = { handler, filter, options };
    },
  },
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"),
  { browser: { webRequest }, URL },
);

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"),
);

test("intercepts only main-frame navigation to the intended hosts", () => {
  assert.deepEqual(Array.from(listeners.headers.filter.types), ["main_frame"]);
  assert.deepEqual(Array.from(listeners.redirect.filter.types), ["main_frame"]);
  assert.deepEqual(Array.from(listeners.headers.options), ["blocking", "requestHeaders"]);
  assert.deepEqual(Array.from(listeners.redirect.options), ["blocking"]);
  assert.deepEqual(
    Array.from(listeners.headers.filter.urls),
    manifest.host_permissions.filter((host) => host.includes("redd.it")),
  );
});

test("replaces HTML Accept while keeping unrelated headers", () => {
  const headers = [
    { name: "aCcEpT", value: "text/html,application/xhtml+xml" },
    { name: "User-Agent", value: "Firefox" },
  ];
  const result = listeners.headers.handler({ requestHeaders: headers });
  assert.equal(result.requestHeaders, headers);
  assert.equal(headers[0].value.includes("text/html"), false);
  assert.equal(headers[0].value.includes("image/"), true);
  assert.deepEqual(headers[1], { name: "User-Agent", value: "Firefox" });
});

test("supplies an image Accept header when missing", () => {
  const { requestHeaders } = listeners.headers.handler({ requestHeaders: [] });
  assert.equal(requestHeaders.length, 1);
  assert.equal(requestHeaders[0].name, "Accept");
  assert.match(requestHeaders[0].value, /^image\//);
});

test("unwraps Reddit media page without altering the image URL", () => {
  const image = "https://preview.redd.it/example.jpeg?width=1128&format=pjpg&auto=webp&s=abc";
  const media = `https://www.reddit.com/media?url=${encodeURIComponent(image)}`;
  assert.equal(listeners.redirect.handler({ url: media }).redirectUrl, image);
  assert.equal(
    listeners.redirect.handler({ url: `https://reddit.com/media?url=${encodeURIComponent(image)}` }).redirectUrl,
    image,
  );
});

test("unwraps only HTTPS image URLs on exact Reddit image hosts", () => {
  for (const hostname of ["i.redd.it", "preview.redd.it", "cf.preview.redd.it", "external-preview.redd.it"]) {
    const url = `https://www.reddit.com/media?url=${encodeURIComponent(`https://${hostname}/a.jpg`)}`;
    assert.equal(listeners.redirect.handler({ url }).redirectUrl, `https://${hostname}/a.jpg`);
  }

  for (const target of [
    "https://evil.example/a.jpg",
    "https://i.redd.it.evil.example/a.jpg",
    "http://i.redd.it/a.jpg",
    "https://user@i.redd.it/a.jpg",
    "https://i.redd.it:8443/a.jpg",
    "javascript:alert(1)",
    "not a URL",
  ]) {
    const url = `https://www.reddit.com/media?url=${encodeURIComponent(target)}`;
    assert.equal(listeners.redirect.handler({ url }), undefined, target);
  }
});

test("leaves unrelated Reddit pages and incomplete media links alone", () => {
  for (const url of [
    "https://www.reddit.com/media",
    "https://www.reddit.com/media?url=",
    "https://www.reddit.com/media-gallery?url=https%3A%2F%2Fi.redd.it%2Fa.jpg",
    "https://www.reddit.com/r/test?url=https%3A%2F%2Fi.redd.it%2Fa.jpg",
  ]) {
    assert.equal(listeners.redirect.handler({ url }), undefined, url);
  }
});
