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
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
