import type { MetadataRoute } from 'next';

/**
 * `/robots.txt`. The public demo surfaces are crawlable; the operator console
 * and the JSON API are not content.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/operator', '/api/'],
    },
  };
}
