import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, 'expected 32 random bytes as hex (pnpm keygen)');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.url(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  DATABASE_URL: z.string().startsWith('postgresql://'),
  MIGRATION_DATABASE_URL: z.string().startsWith('postgresql://').optional(),

  TOKEN_ENC_KEYS: z.string().transform((raw, ctx) => {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const ring = new Map<number, Buffer>();
      for (const [v, b64] of Object.entries(parsed)) {
        const key = Buffer.from(b64, 'base64');
        if (key.length !== 32) throw new Error(`key version ${v} is ${key.length} bytes, expected 32`);
        ring.set(Number(v), key);
      }
      return ring;
    } catch (err) {
      // Never echo the value: parse errors quote the input, and this input is a key.
      const msg = err instanceof SyntaxError ? 'must be JSON like {"1":"<base64 32-byte key>"}' : (err as Error).message;
      ctx.addIssue({ code: 'custom', message: msg });
      return z.NEVER;
    }
  }),
  TOKEN_ENC_ACTIVE_VERSION: z.coerce.number().int().positive(),
  CONNECT_LINK_SECRET: hex32,

  QBO_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  QBO_CLIENT_ID: z.string().min(10),
  QBO_CLIENT_SECRET: z.string().min(10),
  QBO_REDIRECT_URI: z.url(),
  QBO_WEBHOOK_VERIFIER: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse and validate process.env once. Fails fast listing every problem, never echoing secret values. */
export function env(): Env {
  if (cached) return cached;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  if (!result.data.TOKEN_ENC_KEYS.has(result.data.TOKEN_ENC_ACTIVE_VERSION)) {
    throw new Error('Invalid environment:\n  - TOKEN_ENC_ACTIVE_VERSION: no matching key in TOKEN_ENC_KEYS');
  }
  cached = result.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
