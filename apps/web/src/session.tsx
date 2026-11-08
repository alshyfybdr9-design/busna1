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
