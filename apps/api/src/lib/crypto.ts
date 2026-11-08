import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // حساب وهمي عند غياب الحساب لتقليل فرق التوقيت
    await scryptAsync(password, randomBytes(16), 64, PARAMS);
    return false;
  }
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function isStrongPassword(pw: string) {
  return pw.length >= 8 && pw.length <= 128 && /[A-Za-z؀-ۿ]/.test(pw) && /\d/.test(pw);
}
