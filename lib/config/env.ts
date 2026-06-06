import 'server-only';

import { parseEnv, type Env } from './env.schema';

/**
 * Server-only environment access.
 *
 * The `server-only` import makes it a build error to pull this module (and the
 * secrets it exposes) into a client component. Validation runs eagerly at first
 * import, so a missing or malformed required variable crashes the server at
 * startup with a redacted message rather than failing deep inside a request.
 */
export const ENV: Env = parseEnv(process.env);

export type { Env } from './env.schema';
