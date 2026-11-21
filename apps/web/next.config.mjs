const API = process.env.API_URL || "http://127.0.0.1:4100";

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // REST calls are proxied same-origin (session cookie); SSE connects directly to the API with a short-lived ticket
  async rewrites() { return [{ source: "/api/:path*", destination: `${API}/api/:path*` }]; },
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] }];
  },
};
