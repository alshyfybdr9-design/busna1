import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, onSessionChange, refresh, type SessionPayload } from './session';

interface SessionState {
  session: SessionPayload | null;
  ready: boolean;
  /** الجلسة محفوظة لكن تعذر التحقق منها لعدم وجود اتصال */
  offlineStart: boolean;
  retry: () => void;
}

const Ctx = createContext<SessionState>({ session: null, ready: false, offlineStart: false, retry: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [ready, setReady] = useState(false);
  const [offlineStart, setOfflineStart] = useState(false);
  const boot = useCallback(() => {
    setReady(false);
    refresh()
      .then(() => setOfflineStart(false))
      .catch((e) => setOfflineStart(e instanceof ApiError && e.status === 0))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    onSessionChange(setSession);
    boot();
  }, [boot]);
  return <Ctx.Provider value={{ session, ready, offlineStart, retry: boot }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
