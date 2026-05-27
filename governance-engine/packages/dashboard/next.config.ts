import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@auzaar/core",
    "@auzaar/event-log",
    "@auzaar/mandate-service",
    "@auzaar/governance-engine",
  ],
  // SEC-16: Apply security headers to all routes.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            // Restrict resource loading to same origin; allow inline styles for
            // shadcn/ui and Next.js runtime scripts. Tighten in production as needed.
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            // 2-year max-age with subdomains; preload flag for HSTS preload list eligibility.
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
