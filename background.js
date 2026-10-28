const IMAGE_HOSTS = [
  "i.redd.it",
  "preview.redd.it",
  "cf.preview.redd.it",
  "external-preview.redd.it",
];

const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5";

function acceptImages({ requestHeaders }) {
  const headers = requestHeaders || [];
  const accept = headers.find((header) => header.name.toLowerCase() === "accept");

  if (accept) {
    accept.value = IMAGE_ACCEPT;
  } else {
    headers.push({ name: "Accept", value: IMAGE_ACCEPT });
  }

  return { requestHeaders: headers };
}

browser.webRequest.onBeforeSendHeaders.addListener(
  acceptImages,
  {
    urls: IMAGE_HOSTS.map((hostname) => `https://${hostname}/*`),
    types: ["main_frame"],
  },
  ["blocking", "requestHeaders"],
);

function directMediaImage({ url }) {
  const media = new URL(url);
  if (media.pathname !== "/media") return;

  const target = media.searchParams.get("url");
  if (!target) return;

  let image;
  try {
    image = new URL(target);
  } catch {
    return;
  }

  if (
    image.protocol !== "https:" ||
    !IMAGE_HOSTS.includes(image.hostname) ||
    image.username ||
    image.password ||
    image.port
  ) {
    return;
  }

  return { redirectUrl: image.href };
}

browser.webRequest.onBeforeRequest.addListener(
  directMediaImage,
  {
    urls: ["https://www.reddit.com/media*", "https://reddit.com/media*"],
    types: ["main_frame"],
  },
  ["blocking"],
);
