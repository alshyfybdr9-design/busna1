import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import { ApiError, setApiLang } from '../lib/session';

export const C = {
  green: '#16a34a', greenDark: '#166534', greenLight: '#dcfce7', greenBg: '#f0fdf4',
  ink: '#0f1f17', muted: '#52615a', line: '#dfe9e3', bg: '#f6faf7', white: '#fff',
  red: '#b91c1c', redBg: '#fef2f2', amber: '#a16207', amberBg: '#fefce8', blue: '#1d4ed8', blueBg: '#eff6ff',
};

// ---------------- اللغة ----------------
const LangCtx = createContext<{ lang: 'ar' | 'en'; setLang: (l: 'ar' | 'en') => void }>({ lang: 'ar', setLang: () => {} });
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<'ar' | 'en'>('ar');
  const setLang = (l: 'ar' | 'en') => {
    setApiLang(l);
    setLangState(l);
  };
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}
export function useLang() {
  const { lang, setLang } = useContext(LangCtx);
  return { lang, setLang, tr: (ar: string, en: string) => (lang === 'ar' ? ar : en) };
}

export const RIDER_LABEL: Record<string, [string, string]> = {
  expected: ['بانتظار الصعود', 'Awaiting pickup'], boarded: ['في الباص', 'On the bus'], alighted: ['نزل', 'Dropped off'],
  absent: ['غائب', 'Absent'], no_show: ['لم يحضر', 'No-show'],
};
export const TRIP_LABEL: Record<string, [string, string]> = {
  scheduled: ['مجدولة', 'Scheduled'], in_progress: ['جارية', 'In progress'], completed: ['مكتملة', 'Completed'], cancelled: ['ملغاة', 'Cancelled'],
};
export const DIR_LABEL: Record<string, [string, string]> = { to_school: ['الذهاب', 'To school'], from_school: ['العودة', 'From school'], both: ['الذهاب والعودة', 'Both'] };

export function ageText(sec: number, lang: 'ar' | 'en') {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (sec < 60) return rtf.format(-sec, 'second');
  if (sec < 3600) return rtf.format(-Math.floor(sec / 60), 'minute');
  return rtf.format(-Math.floor(sec / 3600), 'hour');
}
export function timeText(ts: string | null | undefined, lang: 'ar' | 'en') {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---------------- مكونات ----------------
/** onRefresh: يفعّل السحب للأسفل لتحديث الشاشة */
export function Screen({ children, scroll = true, padded = true, onRefresh }: { children: ReactNode; scroll?: boolean; padded?: boolean; onRefresh?: () => Promise<unknown> | void }) {
  const [refreshing, setRefreshing] = useState(false);
  const body = <View style={padded ? { padding: 16, gap: 12 } : undefined}>{children}</View>;
  const refresh = onRefresh
    ? <RefreshControl refreshing={refreshing} tintColor={C.green} colors={[C.green]} onRefresh={async () => { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }} />
    : undefined;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom']}>
      <OfflineBanner />
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled" refreshControl={refresh}>{body}</ScrollView> : <View style={{ flex: 1 }}>{body}</View>}
    </SafeAreaView>
  );
}

export function OfflineBanner() {
  const { tr } = useLang();
  const [offline, setOffline] = useState(false);
  useEffect(() => NetInfo.addEventListener((s) => setOffline(s.isConnected === false)), []);
  if (!offline) return null;
  return (
    <View style={{ backgroundColor: C.amberBg, padding: 8 }}>
      <T style={{ color: C.amber, textAlign: 'center', fontWeight: '700' }}>{tr('لا يوجد اتصال — يتم الحفظ محليًا والمزامنة لاحقًا', 'Offline — saving locally, will sync later')}</T>
    </View>
  );
}

export function T({ children, style, muted, size, bold }: { children: ReactNode; style?: any; muted?: boolean; size?: number; bold?: boolean }) {
  return (
    <Text style={[{ color: muted ? C.muted : C.ink, fontSize: size ?? 16, fontWeight: bold ? '700' : '400', textAlign: 'left', writingDirection: 'auto' }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

type BtnKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'warn';
export function Btn({ title, onPress, kind = 'primary', big, disabled, busy, style }: { title: string; onPress: () => void; kind?: BtnKind; big?: boolean; disabled?: boolean; busy?: boolean; style?: ViewStyle }) {
  const bg = { primary: C.green, secondary: C.white, danger: C.red, ghost: 'transparent', warn: C.amber }[kind];
  const fg = kind === 'secondary' ? C.greenDark : kind === 'ghost' ? C.muted : C.white;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, minHeight: big ? 64 : 48, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, borderWidth: kind === 'secondary' ? 1 : 0 }, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: big ? 20 : 16, fontWeight: '700', textAlign: 'center' }}>{title}</Text>}
    </Pressable>
  );
}

export function Pill({ text, tone = 'green' }: { text: string; tone?: 'green' | 'gray' | 'red' | 'amber' | 'blue' }) {
  const map = { green: [C.greenLight, C.greenDark], gray: ['#eef2f0', C.muted], red: [C.redBg, C.red], amber: [C.amberBg, C.amber], blue: [C.blueBg, C.blue] }[tone];
  return (
    <View style={{ backgroundColor: map[0], borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: map[1], fontWeight: '700', fontSize: 13 }}>{text}</Text>
    </View>
  );
}

export function Loading() {
  return <View style={{ padding: 32 }}><ActivityIndicator color={C.green} size="large" /></View>;
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { tr } = useLang();
  const msg = error instanceof ApiError ? error.message : tr('حدث خطأ غير متوقع', 'Unexpected error');
  return (
    <Card style={{ backgroundColor: C.redBg, borderColor: '#fecaca' }}>
      <T style={{ color: C.red }}>{msg}</T>
      {onRetry && <Btn title={tr('إعادة المحاولة', 'Retry')} kind="secondary" onPress={onRetry} style={{ marginTop: 8 }} />}
    </Card>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <T bold size={14}>{label}</T>
      {children}
      {hint && <T muted size={13}>{hint}</T>}
    </View>
  );
}

export const s = StyleSheet.create({
  card: { backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 14, gap: 8 },
  btn: { borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderColor: '#bbf7d0' },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, minHeight: 48, backgroundColor: C.white, fontSize: 16, color: C.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});

/** يعيد تحميل البيانات دوريًا أثناء ظهور الشاشة */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () =>
      fn().then((d) => { if (alive) { setData(d); setError(null); } }, (e) => alive && setError(e)).finally(() => alive && setLoading(false));
    run();
    const h = intervalMs > 0 ? setInterval(run, intervalMs) : null;
    return () => { alive = false; if (h) clearInterval(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  /** تحديث فوري ينتظر النتيجة (للسحب للأسفل) */
  const refresh = async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  return { data, error, loading, reload: () => setTick((x) => x + 1), refresh };
}
