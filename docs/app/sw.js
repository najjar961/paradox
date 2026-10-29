// Paradox Lite service worker: makes the app installable and usable offline.
//
// What it stores: only this app's own files (HTML, scripts, fonts, libraries), in the
// browser's Cache Storage, so the page opens without internet. It never sees or stores
// your documents or chats: those are never requested over the network at all.
// It does not handle requests to other sites (the AI models cache themselves), but it counts
// the requests the app's background workers make, for the live privacy check in the sidebar:
// which site, and how many bytes each request sends. It reports that to the open Paradox pages only.

const SHELL_CACHE = "paradox-shell-v8";   // changes with every release (network first)
const VENDOR_CACHE = "paradox-vendor-v2"; // bump only when a file in vendor/ changes

const SHELL = [
  "./", "index.html", "app.js", "app.css", "i18n.js", "layout.js", "office.js", "compare.js",
  "worker.js", "embed-worker.js", "markdown.js", "tools.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
  "samples/statistics-en.md", "samples/statistics-de.md", "samples/statistics-fr.md", "samples/statistics-ar.md",
];

// Everything else the app can load. Cached when first used, or all at once ("warm")
// after a model has been loaded, so every feature works offline from then on.
const VENDOR = [
  "vendor/DejaVuSans.ttf",
  "vendor/docx.iife.js",
  "vendor/fonts/Carlito-Bold.ttf",
  "vendor/fonts/Carlito-Regular.ttf",
  "vendor/fonts/DejaVuSans-Bold.ttf",
  "vendor/fonts/DejaVuSans.ttf",
  "vendor/fonts/LiberationSans-Bold.ttf",
  "vendor/fonts/LiberationSans-Regular.ttf",
  "vendor/fonts/LiberationSerif-Bold.ttf",
  "vendor/fonts/LiberationSerif-Regular.ttf",
  "vendor/jspdf.umd.min.js",
  "vendor/jszip.min.js",
  "vendor/katex/fonts/KaTeX_AMS-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2",
  "vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2",
  "vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Main-Bold.woff2",
  "vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2",
  "vendor/katex/fonts/KaTeX_Main-Italic.woff2",
  "vendor/katex/fonts/KaTeX_Main-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2",
  "vendor/katex/fonts/KaTeX_Math-Italic.woff2",
  "vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2",
  "vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2",
  "vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Script-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size1-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size2-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size3-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size4-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2",
  "vendor/katex/katex.min.css",
  "vendor/katex/katex.min.js",
  "vendor/mammoth.browser.min.js",
  "vendor/mupdf/mupdf-wasm.js",
  "vendor/mupdf/mupdf-wasm.wasm",
  "vendor/mupdf/mupdf.js",
  "vendor/pdf.min.mjs",
  "vendor/pdf.worker.min.mjs",
  "vendor/tesseract/core/tesseract-core-lstm.wasm.js",
  "vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js",
  "vendor/tesseract/lang/ara.traineddata.gz",
  "vendor/tesseract/lang/deu.traineddata.gz",
  "vendor/tesseract/lang/eng.traineddata.gz",
  "vendor/tesseract/lang/fra.traineddata.gz",
  "vendor/tesseract/tesseract.min.js",
  "vendor/tesseract/worker.min.js",
  "vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
  "vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm",
  "vendor/transformers/transformers.min.js",
  "vendor/web-llm.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("paradox-") && name !== SHELL_CACHE && name !== VENDOR_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// Live privacy check. The page counts its own requests itself (Resource Timing); requests from
// workers (AI model, search model, text recognition) are only visible here, so they are reported.
function reportWorkerRequest(event) {
  if (!event.clientId) return;
  event.waitUntil((async () => {
    const client = await self.clients.get(event.clientId);
    if (!client || client.type === "window") return;
    const req = event.request;
    let sent = 0;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { sent = (await req.clone().arrayBuffer()).byteLength; } catch { sent = -1; }
    }
    const report = { type: "paradox-request", host: new URL(req.url).host, method: req.method, sent };
    for (const page of await self.clients.matchAll({ type: "window" })) page.postMessage(report);
  })());
}

self.addEventListener("fetch", (event) => {
  reportWorkerRequest(event);
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL("./", self.location).pathname)) return;
  if (url.pathname.includes("/vendor/")) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(VENDOR_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

// Online: always the newest version of the app. Offline: the last one seen.
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // "no-cache" asks GitHub whether the file changed instead of trusting the browser's
    // 10-minute HTTP cache, so a new page never runs with an old app.js after an update.
    const res = await fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }));
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === "navigate" ? await cache.match("index.html") : null);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "warm") return;
  event.waitUntil((async () => {
    const cache = await caches.open(VENDOR_CACHE);
    let done = 0;
    for (const path of VENDOR) {
      const url = new URL(path, self.location).href;
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
        }
        done++;
      } catch { /* offline or interrupted: try again next time */ }
    }
    event.source?.postMessage({ type: "warmed", complete: done === VENDOR.length });
  })());
});
