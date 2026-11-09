import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, onSessionChange, refresh, type SessionPayload } from './session';

interface SessionState {
  session: SessionPayload | null;
  ready: boolean;
  /** الجلسة محفوظة لكن تعذر التحقق منها لعدم وجود اتصال */
  offlineStart: boolean;
  /** نص الخطأ (يتضمن عنوان الخادم في وضع التطوير) لتسهيل التشخيص */
  offlineError: string | null;
  retry: () => void;
}

const Ctx = createContext<SessionState>({ session: null, ready: false, offlineStart: false, offlineError: null, retry: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [ready, setReady] = useState(false);
  const [offlineStart, setOfflineStart] = useState(false);
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const boot = useCallback(() => {
    setReady(false);
    refresh()
      .then(() => { setOfflineStart(false); setOfflineError(null); })
      .catch((e) => {
        const offline = e instanceof ApiError && e.status === 0;
        setOfflineStart(offline);
        setOfflineError(offline ? e.message : null);
      })
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    onSessionChange(setSession);
    boot();
  }, [boot]);
  return <Ctx.Provider value={{ session, ready, offlineStart, offlineError, retry: boot }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
