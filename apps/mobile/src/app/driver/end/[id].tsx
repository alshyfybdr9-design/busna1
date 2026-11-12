import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { api, ApiError } from '../../../lib/session';
import { enqueueEvent, flushEvents, pendingCounts } from '../../../lib/queue';
import { stopTracking } from '../../../lib/tracking';
import { Btn, C, Card, ErrorView, Loading, Screen, T, s, useLang } from '../../../components/ui';

const ITEMS: Record<string, [string, string]> = {
  walkedToRear: ['مشيت حتى آخر الباص', 'I walked to the rear of the bus'],
  checkedSeats: ['فحصت كل المقاعد', 'I checked every seat'],
  checkedUnderSeats: ['فحصت أسفل المقاعد', 'I checked under the seats'],
  checkedBackRow: ['فحصت الصف الأخير والزوايا', 'I checked the back row and corners'],
  noBelongingsLeft: ['لا توجد أغراض متروكة', 'No belongings left behind'],
};

type Unresolved = { onboard: Array<{ studentId: string; fullName: string }>; unrecorded: Array<{ studentId: string; fullName: string }> };

export default function EndTrip() {
  const { id = '', rearToken } = useLocalSearchParams<{ id: string; rearToken?: string }>();
  const { tr } = useLang();
  const [trip, setTrip] = useState<any>(null);
  const [step, setStep] = useState<'confirm' | 'unresolved' | 'inspect' | 'done'>('confirm');
  const [unresolved, setUnresolved] = useState<Unresolved | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<string | null>(null);
  const inspectStarted = useRef<string | null>(null);
  const inspectionId = useRef(Crypto.randomUUID());

  const load = useCallback(async () => {
    const d = await api('GET', `/driver/trips/${id}`);
    setTrip(d);
    if (d.trip.status === 'completed') setStep(d.trip.inspectionStatus === 'pending' ? 'inspect' : 'done');
  }, [id]);
  useEffect(() => { load().catch(setErr); }, [load]);
  useEffect(() => { if (step === 'inspect' && !inspectStarted.current) inspectStarted.current = new Date().toISOString(); }, [step]);

  async function end(acknowledgeUnresolved = false) {
    setBusy(true);
    setErr(null);
    try {
      // لا يُنهى قبل مزامنة كل أحداث الصعود والنزول المحفوظة محليًا
      await flushEvents().catch(() => {});
      const pc = await pendingCounts(id);
      if (pc.events > 0) throw new ApiError(0, 'network', tr('توجد أحداث لم تُزامن بعد. تحتاج اتصالًا بالإنترنت لإنهاء الرحلة.', 'Some events are not synced yet. You need a connection to end the trip.'));
      await api('POST', `/driver/trips/${id}/end`, { acknowledgeUnresolved });
      await stopTracking(id); // إيقاف جمع الموقع فور انتهاء الرحلة
      setStep('inspect');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unresolved_riders') {
        setUnresolved(e.details);
        setStep('unresolved');
      } else setErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function resolve(studentId: string, type: 'alighted' | 'no_show') {
    await enqueueEvent(id, { clientEventId: Crypto.randomUUID(), studentId, type, recordedAt: new Date().toISOString(), source: 'manual' });
    await flushEvents().catch(() => {});
    setUnresolved((u) => u && {
      onboard: u.onboard.filter((x) => x.studentId !== studentId),
      unrecorded: u.unrecorded.filter((x) => x.studentId !== studentId),
    });
  }

  async function submitInspection(res: 'bus_empty' | 'child_found' | 'issue', issueCategory?: string) {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `/driver/trips/${id}/inspection`, {
        clientEventId: inspectionId.current,
        startedAt: inspectStarted.current ?? new Date().toISOString(),
        checklist: Object.fromEntries(Object.keys(ITEMS).map((k) => [k, !!checks[k]])),
        result: res,
        ...(rearToken ? { rearQrToken: rearToken } : {}),
        ...(issueCategory ? { issueCategory } : {}),
      });
      setResult(res);
      setStep('done');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  function childFound() {
    const phone = trip?.safety?.supervisorPhone;
    Alert.alert(tr('طفل داخل الباص', 'Child on the bus'), tr('ابقَ مع الطفل واتصل بالمشرف فورًا. سيتم إرسال تنبيه حرج.', 'Stay with the child and call the supervisor now. A critical alert will be sent.'), [
      { text: tr('اتصال بالمشرف', 'Call supervisor'), onPress: () => { submitInspection('child_found'); if (phone) Linking.openURL(`tel:${phone}`); } },
      { text: tr('إرسال التنبيه فقط', 'Send alert only'), onPress: () => submitInspection('child_found') },
    ]);
  }

  if (!trip && !err) return <Loading />;
  const allChecked = Object.keys(ITEMS).every((k) => checks[k]);
  const requireRear = !!trip?.safety?.requireRearQrScan;

  return (
    <Screen>
      {err != null && <ErrorView error={err} />}

      {step === 'confirm' && trip?.myRole === 'attendant' && (
        <Card>
          <T bold size={20}>{tr('السائق ينهي الرحلة', 'The driver ends the trip')}</T>
          <T muted>{tr('بعد أن ينهي السائق الرحلة، يظهر لك هنا فحص خلو الباص. تأكد من تسجيل نزول كل الطلاب أولًا.', 'After the driver ends the trip, the bus-empty check appears here. Make sure every student is recorded as dropped off first.')}</T>
          <Btn kind="secondary" title={tr('تحديث', 'Refresh')} onPress={() => load().catch(setErr)} />
          <Btn kind="ghost" title={tr('رجوع', 'Back')} onPress={() => router.back()} />
        </Card>
      )}
      {step === 'confirm' && trip && trip.myRole !== 'attendant' && (
        <Card>
          <T bold size={20}>{tr('إنهاء الرحلة', 'End trip')}</T>
          <T muted>{tr('عند الإنهاء تتوقف مشاركة الموقع، ثم يُطلب منك فحص خلو الباص.', 'Ending stops location sharing, then you must check the bus is empty.')}</T>
          <Btn big kind="warn" title={tr('إنهاء الرحلة', 'End trip')} busy={busy} onPress={() => end(false)} />
          <Btn kind="ghost" title={tr('رجوع', 'Back')} onPress={() => router.back()} />
        </Card>
      )}

      {step === 'unresolved' && unresolved && (
        <>
          {unresolved.onboard.length > 0 && (
            <Card style={{ borderColor: C.red, borderWidth: 2 }}>
              <T bold size={18} style={{ color: C.red }}>{tr('طلاب صعدوا ولم يُسجّل نزولهم', 'Boarded but not dropped off')}</T>
              <T muted>{tr('تأكد من مكان كل طالب قبل المتابعة.', 'Confirm where each student is before continuing.')}</T>
              {unresolved.onboard.map((r) => (
                <View key={r.studentId} style={[s.row, { justifyContent: 'space-between', paddingVertical: 6 }]}>
                  <T size={18}>{r.fullName}</T>
                  <Btn title={tr('نزل', 'Dropped off')} onPress={() => resolve(r.studentId, 'alighted')} />
                </View>
              ))}
            </Card>
          )}
          {unresolved.unrecorded.length > 0 && (
            <Card style={{ borderColor: C.amber, borderWidth: 2 }}>
              <T bold size={18} style={{ color: C.amber }}>{tr('طلاب بلا تسجيل', 'Students with no record')}</T>
              {unresolved.unrecorded.map((r) => (
                <View key={r.studentId} style={[s.row, { justifyContent: 'space-between', paddingVertical: 6 }]}>
                  <T size={18}>{r.fullName}</T>
                  <Btn kind="secondary" title={tr('لم يحضر', 'No-show')} onPress={() => resolve(r.studentId, 'no_show')} />
                </View>
              ))}
            </Card>
          )}
          {unresolved.onboard.length + unresolved.unrecorded.length === 0
            ? <Btn big title={tr('إنهاء الرحلة', 'End trip')} busy={busy} onPress={() => end(false)} />
            : <Btn big kind="danger" busy={busy} title={tr('إنهاء وتصعيد للمشرف', 'End and escalate to supervisor')} onPress={() => end(true)} />}
        </>
      )}

      {step === 'inspect' && (
        <>
          <Card>
            <T bold size={20}>{tr('فحص خلو الباص', 'Bus-empty check')}</T>
            <T muted>{tr('امشِ داخل الباص حتى آخره وتحقق بنفسك. هذا إقرار منك يُحفظ بالوقت.', 'Walk to the back and check yourself. This declaration is time-stamped.')}</T>
          </Card>
          {Object.entries(ITEMS).map(([k, label]) => (
            <Pressable key={k} onPress={() => setChecks({ ...checks, [k]: !checks[k] })} accessibilityRole="checkbox" accessibilityState={{ checked: !!checks[k] }}>
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, borderColor: checks[k] ? C.green : C.line, borderWidth: checks[k] ? 2 : 1 }}>
                <T size={26}>{checks[k] ? '☑' : '☐'}</T>
                <T size={18}>{tr(...label)}</T>
              </Card>
            </Pressable>
          ))}
          <Card>
            <T>{rearToken ? tr('✓ تم مسح رمز مؤخرة الباص', '✓ Rear-of-bus code scanned') : requireRear ? tr('مطلوب: امسح الملصق في مؤخرة الباص', 'Required: scan the rear sticker') : tr('اختياري: امسح الملصق في مؤخرة الباص', 'Optional: scan the rear sticker')}</T>
            {!rearToken && <Btn kind="secondary" title={tr('مسح رمز مؤخرة الباص', 'Scan rear code')} onPress={() => router.push({ pathname: '/driver/scan/[id]', params: { id, mode: 'rear' } })} />}
          </Card>
          <Btn big title={tr('الباص خالٍ — تأكيد', 'Bus is empty — confirm')} disabled={!allChecked || (requireRear && !rearToken)} busy={busy} onPress={() => submitInspection('bus_empty')} />
          <Btn big kind="danger" title={tr('وجدت طفلًا داخل الباص', 'I found a child on the bus')} onPress={childFound} />
          <View style={s.row}>
            <Btn kind="secondary" style={{ flex: 1 }} title={tr('أغراض متروكة', 'Lost item')} onPress={() => submitInspection('issue', 'lost_item')} />
            <Btn kind="secondary" style={{ flex: 1 }} title={tr('تلف/مشكلة', 'Damage/issue')} onPress={() => submitInspection('issue', 'damage')} />
          </View>
        </>
      )}

      {step === 'done' && (
        <Card>
          <T bold size={20}>{result === 'child_found' ? tr('أُرسل تنبيه حرج للمشرف', 'Critical alert sent') : tr('اكتملت الرحلة', 'Trip complete')}</T>
          <T muted>{tr('تم حفظ نتيجة الفحص ووقتها.', 'Check result and time recorded.')}</T>
          <Btn big title={tr('العودة للرحلات', 'Back to trips')} onPress={() => router.replace('/driver')} />
        </Card>
      )}
    </Screen>
  );
}
