// @ts-check

/**
 * Next.js configuration for Vector.
 *
 * `reactStrictMode` surfaces accidental side-effects early. No network calls
 * happen at build time: the seeded config is static and the database is only
 * contacted at request time by `/api/health`.
 *
 * Runtime metadata such as the deployed commit is read from `process.env`
 * inside server-only code (see `app/api/health/route.ts`); it is never inlined
 * into the client bundle.
 *
 * Security headers (C-07 / frontend F4): applied globally via the Next.js
 * `headers()` config so every route — API, page, and static asset — benefits
 * without per-route boilerplate. Individual API routes may add more specific
 * headers (e.g. `Cache-Control: no-store`); these global headers are additive.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,

  // Don't advertise the framework in response headers.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Apply to all routes.
        source: '/(.*)',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            // Second line of defence against XSS: no external scripts, no
            // embedding, no plugins, forms/navigation stay same-origin.
            // `'unsafe-inline'` for script/style is required by Next.js App
            // Router (inline flight-data scripts and injected styles); a
            // stricter nonce-based policy needs middleware and is out of
            // scope here.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
