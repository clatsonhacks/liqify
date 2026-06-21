/** @type {import('next').NextConfig} */

// The SeFi/LiquidShield backend (Express) runs separately. We proxy all
// browser `/api/*` calls to it through Next rewrites so the dashboard talks to
// the real backend with no CORS setup. Override with BACKEND_URL in env.
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3210";

const nextConfig = {
  async rewrites() {
    return [
      // LiquidShield routes are mounted at /api/* on the backend.
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
    ];
  },
};

export default nextConfig;
