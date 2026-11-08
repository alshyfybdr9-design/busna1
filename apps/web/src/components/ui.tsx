import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { useI18n, formatAge } from '../i18n';

export function Loading() {
  const { t } = useI18n();
  return <div className="muted" role="status">{t('loading')}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const msg = error instanceof ApiError ? error.message : String((error as Error)?.message ?? error);
  return (
    <div className="alert error row between" role="alert">
      <span>{msg}</span>
      {onRetry && <button className="btn sm secondary" onClick={onRetry}>{t('retry')}</button>}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <div className="muted" style={{ padding: '16px 0' }}>{children ?? t('empty')}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const TRIP_COLORS: Record<string, string> = { scheduled: 'gray', in_progress: 'blue', completed: '', cancelled: 'red' };
const RIDER_COLORS: Record<string, string> = { expected: 'gray', boarded: 'blue', alighted: '', absent: 'amber', no_show: 'red' };

export function TripStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`badge ${TRIP_COLORS[status] ?? ''}`}>{t(`trip_${status}` as any)}</span>;
}
export function RiderStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`badge ${RIDER_COLORS[status] ?? ''}`}>{t(`rider_${status}` as any)}</span>;
}

/** يوضح حداثة الموقع: "مباشر" فقط عندما يكون حديثًا، وإلا "آخر تحديث منذ…" */
export function Freshness({ location }: { location: { ageSeconds: number; isStale: boolean } | null }) {
  const { t, lang } = useI18n();
  if (!location) return <span className="badge gray">{t('noLocation')}</span>;
  if (!location.isStale) return <span className="badge">● {t('live')} · {formatAge(location.ageSeconds, lang)}</span>;
  return <span className="badge amber">{t('lastUpdate')} {formatAge(location.ageSeconds, lang).replace(/^منذ\s*/, '')}</span>;
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function BrandMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#16a34a" />
      <rect x="14" y="16" width="36" height="28" rx="6" fill="#fff" />
      <rect x="18" y="21" width="12" height="9" rx="2" fill="#86efac" />
      <rect x="34" y="21" width="12" height="9" rx="2" fill="#86efac" />
      <circle cx="22" cy="47" r="4" fill="#fff" />
      <circle cx="42" cy="47" r="4" fill="#fff" />
    </svg>
  );
}
