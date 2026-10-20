/**
 * Service worker for the phone app. It makes the app installable and shows a small offline notice; it never caches
 * finance data or API responses (everything else goes straight to the network).
 */
const SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#0b0f0d;color:#fff;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><p>You are offline.<br>Connect to the internet to call the AI Accountant.</p>', { headers: { "content-type": "text/html; charset=utf-8" } })));
});
`;
export function GET() {
  return new Response(SW, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/phone" } });
}
