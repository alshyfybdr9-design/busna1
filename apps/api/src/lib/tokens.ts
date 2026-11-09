import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

export interface AccessClaims {
  sub: string;
  /** سياق مختار: عضوية في جهة، أو منصة، أو لا شيء (قبل الاختيار) */
  ctx: { kind: 'membership'; mid: string } | { kind: 'platform' } | { kind: 'grant'; gid: string } | { kind: 'none' };
}

const key = () => new TextEncoder().encode(config().JWT_SECRET);

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ ctx: claims.ctx })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('busna')
    .setAudience('busna-api')
    .setExpirationTime(`${config().ACCESS_TOKEN_TTL_SEC}s`)
    .sign(key());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(), { issuer: 'busna', audience: 'busna-api', algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || typeof payload.ctx !== 'object' || payload.ctx === null) {
    throw new Error('bad token');
  }
  return { sub: payload.sub, ctx: payload.ctx as AccessClaims['ctx'] };
}
