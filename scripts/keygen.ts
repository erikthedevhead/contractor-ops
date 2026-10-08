// Prints fresh secrets for .env. Run once per environment (dev and prod get different keys).
import { randomBytes } from 'node:crypto';

console.log(`TOKEN_ENC_KEYS={"1":"${randomBytes(32).toString('base64')}"}`);
console.log('TOKEN_ENC_ACTIVE_VERSION=1');
console.log(`CONNECT_LINK_SECRET=${randomBytes(32).toString('hex')}`);
