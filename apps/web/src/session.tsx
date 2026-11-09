import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { refreshSession, setSessionListener, type Session } from './api';

const SessionCtx = createContext<{ session: Session | null; ready: boolean }>({ session: null, ready: false });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setSessionListener(setSession);
    refreshSession()
      .catch(() => null)
      .finally(() => setReady(true));
  }, []);
  return <SessionCtx.Provider value={{ session, ready }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);

export function currentMembership(s: Session | null) {
  if (!s || s.context.kind !== 'membership') return null;
  const mid = s.context.mid;
  return s.contexts.memberships.find((m) => m.membershipId === mid) ?? null;
}

/** سياق الجهة الحالي: عضوية عادية، أو وصول دعم مؤقت (قراءة فقط) لفريق المنصة */
export function currentTenantContext(s: Session | null) {
  if (!s) return null;
  if (s.context.kind === 'membership') {
    const m = currentMembership(s);
    return m ? { role: m.role, tenantName: m.tenantName, tenantNameEn: m.tenantNameEn, id: m.membershipId, readOnly: false, expiresAt: null as string | null } : null;
  }
  if (s.context.kind === 'grant') {
    const gid = s.context.gid;
    const g = s.contexts.accessGrants?.find((x) => x.grantId === gid);
    return g ? { role: 'platform_readonly', tenantName: g.tenantName, tenantNameEn: null, id: g.grantId, readOnly: true, expiresAt: g.expiresAt } : null;
  }
  return null;
}
