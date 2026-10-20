/** PWA manifest for the phone app: installs as "Bilit Phone", opens full-screen on /phone. */
export function GET() {
  return Response.json({
    name: "Bilit Phone — AI Accountant", short_name: "Bilit Phone", description: "Call the Bilit AI Accountant about the finances.",
    id: "/phone", start_url: "/phone", scope: "/phone", display: "standalone", orientation: "portrait",
    background_color: "#0b0f0d", theme_color: "#0b0f0d",
    icons: [
      { src: "/brand/bilit-mark-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/bilit-mark-512.png", sizes: "192x192", type: "image/png", purpose: "any" },
    ],
  }, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
}
