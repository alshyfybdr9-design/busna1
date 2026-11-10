import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { HandoverSheet, openNavigation, ReportSheet, type Receiver } from '../../../components/driver';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { api } from '../../../lib/session';
import { enqueueEvent, flushEvents, pendingCounts, rejectedEvents, clearRejected, type QueuedEvent } from '../../../lib/queue';
import { ensureLocationPermissions, isTracking, startTracking } from '../../../lib/tracking';
import { Btn, C, Card, DIR_LABEL, ErrorView, Loading, Pill, RIDER_LABEL, Screen, T, s, useLang } from '../../../components/ui';

type Rider = { id: string; studentId: string; fullName: string; grade: string | null; stopId: string | null; status: string; requiresHandover?: boolean; receivers?: Receiver[] };
type Stop = { id: string; seq: number; name: string; kind: 'stop' | 'school'; lat: number; lng: number };

const REJECT_TEXT: Record<string, [string, string]> = {
  not_boarded: ['لا يمكن تسجيل نزول طالب لم يُسجّل صعوده. أبلغ المشرف للتصحيح.', 'Cannot drop off a student who never boarded. Ask the supervisor to correct.'],
  invalid_transition: ['تغيير الحالة غير مسموح. أبلغ المشرف.', 'Status change not allowed. Contact supervisor.'],
  trip_not_active: ['الرحلة لم تعد جارية.', 'Trip is no longer active.'],
  not_on_trip: ['الطالب ليس ضمن هذه الرحلة.', 'Student is not on this trip.'],
  invalid_time: ['وقت الجهاز غير صحيح.', 'Device time is incorrect.'],
  handover_required: ['هذا الطالب يتطلب تحديد من استلمه قبل تسجيل نزوله.', 'Choose who received this student before dropping off.'],
  invalid_receiver: ['المستلم المختار لم يعد مصرّحًا له. أعد الاختيار أو تواصل مع المشرف.', 'The chosen receiver is no longer authorized. Choose again or contact the supervisor.'],
};

export default function DriverTrip() {
  const params = useLocalSearchParams<{ id: string; scannedStudent?: string }>();
  const id = params.id ?? '';
  const { tr } = useLang();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [pending, setPending] = useState({ events: 0, locations: 0 });
  const [tracking, setTracking] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [rejected, setRejected] = useState<Array<{ student_id: string; code: string }>>([]);
  const [handoverFor, setHandoverFor] = useState<Rider | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api('GET', `/driver/trips/${id}`);
      setData(d);
      setErr(null);
      setLocal({});
    } catch (e) {
      setErr(e);
    }
  }, [id]);

  const sync = useCallback(async () => {
    try {
      await flushEvents();
    } catch {
      /* سيُعاد لاحقًا */
    }
    setPending(await pendingCounts(id));
    setRejected(await rejectedEvents(id));
    setTracking(await isTracking());
  }, [id]);

  useFocusEffect(useCallback(() => {
    load();
    sync();
    const h = setInterval(sync, 10_000);
    return () => clearInterval(h);
  }, [load, sync]));

  // إعادة تشغيل التتبع إن كانت الرحلة جارية وتوقف (مثلًا بعد إعادة تشغيل الجهاز)
  useEffect(() => {
    if (data?.trip.status === 'in_progress' && tracking === false) {
      ensureLocationPermissions().then((p) => {
        if (p === 'background' || p === 'foreground_only') startTracking(id, data.tracking.intervalSec).then(() => setTracking(true)).catch(() => {});
      });
    }
  }, [data?.trip.status, tracking, id, data?.tracking?.intervalSec]);

  const riders: Rider[] = useMemo(() => (data?.riders ?? []).map((r: Rider) => ({ ...r, status: local[r.studentId] ?? r.status })), [data, local]);
  const stops: Stop[] = data?.stops ?? [];

  const nextStop = useMemo(() => {
    if (!data) return null;
    const dir = data.trip.direction;
    const pickups = stops.filter((st) => st.kind === 'stop');
    const waiting = (st: Stop) => riders.some((r) => r.stopId === st.id && (dir === 'to_school' ? r.status === 'expected' : r.status === 'boarded'));
    return pickups.find(waiting) ?? (dir === 'to_school' ? stops.find((st) => st.kind === 'school') ?? null : null);
  }, [data, riders, stops]);

  async function record(r: Rider, type: QueuedEvent['type'], source: 'manual' | 'qr' = 'manual', handover?: Receiver) {
    // التسليم الآمن: النزول يتطلب اختيار المستلم أولًا
    if (type === 'alighted' && r.requiresHandover && !handover) {
      setHandoverFor(r);
      return;
    }
    const e: QueuedEvent = {
      clientEventId: Crypto.randomUUID(), studentId: r.studentId, type, recordedAt: new Date().toISOString(), source,
      ...(handover ? { handover: { kind: handover.kind, refId: handover.refId } } : {}),
    };
    await enqueueEvent(id, e); // يُحفظ محليًا أولًا ثم يُرسل
    setLocal((l) => ({ ...l, [r.studentId]: type }));
    sync();
  }

  // عائد من شاشة المسح: تأكيد صعود الطالب الممسوح (QR معرّف مساعد فقط)
  useEffect(() => {
    if (!params.scannedStudent || !data) return;
    const r = riders.find((x) => x.studentId === params.scannedStudent);
    if (!r) return;
    router.setParams({ scannedStudent: undefined });
    const action: QueuedEvent['type'] = r.status === 'boarded' ? 'alighted' : 'boarded';
    Alert.alert(r.fullName, action === 'boarded' ? tr('تأكيد صعود هذا الطالب؟ تحقق منه بصريًا.', 'Confirm boarding? Verify visually.') : tr('تأكيد نزول هذا الطالب؟', 'Confirm drop-off?'), [
      { text: tr('إلغاء', 'Cancel'), style: 'cancel' },
      { text: tr('تأكيد', 'Confirm'), onPress: () => record(r, action, 'qr') },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.scannedStudent, data]);

  async function startTrip() {
    setStarting(true);
    try {
      const perm = await ensureLocationPermissions();
      if (perm === 'services_off' || perm === 'denied') {
        const ok = await new Promise<boolean>((res) => Alert.alert(
          tr('الموقع غير متاح', 'Location unavailable'),
          perm === 'services_off'
            ? tr('خدمات الموقع مغلقة في الجهاز. فعّلها ليتمكن أولياء الأمور من متابعة الباص.', 'Location services are off. Turn them on so parents can follow the bus.')
            : tr('رُفض إذن الموقع. لن يظهر موقع الباص لأولياء الأمور أو الإدارة، وسيصل تنبيه للمشرف. يمكنك تفعيله من الإعدادات.', 'Location permission denied. The bus will not be visible and the supervisor will be alerted. You can enable it in Settings.'),
          [
            { text: tr('فتح الإعدادات', 'Open settings'), onPress: () => { Linking.openSettings(); res(false); } },
            { text: tr('بدء بدون موقع', 'Start without location'), style: 'destructive', onPress: () => res(true) },
            { text: tr('إلغاء', 'Cancel'), style: 'cancel', onPress: () => res(false) },
          ],
        ));
        if (!ok) return;
      }
      const r = await api('POST', `/driver/trips/${id}/start`, {});
      if (perm === 'background' || perm === 'foreground_only') {
        await startTracking(id, r.tracking.intervalSec);
        setTracking(true);
        if (perm === 'foreground_only') {
          Alert.alert(tr('تنبيه', 'Note'), tr('لم يُسمح بالموقع "دائمًا". سيتوقف إرسال الموقع عند إغلاق التطبيق أو قفل الشاشة. للتتبع المستمر اختر "السماح دائمًا" من الإعدادات.', 'Location is not set to "Always". Tracking stops when the app is closed. Choose "Allow all the time" in Settings.'));
        }
      }
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setStarting(false);
    }
  }

  if (!data && !err) return <Loading />;
  if (!data) return <Screen><ErrorView error={err} onRetry={load} /></Screen>;
  const trip = data.trip;
  const active = trip.status === 'in_progress';
  const byStop = stops.filter((st) => st.kind === 'stop').map((st) => ({ stop: st, riders: riders.filter((r) => r.stopId === st.id) }));

  return (
    <Screen>
      <Card>
        <T bold size={20}>{trip.route?.name}</T>
        <T muted>{tr(...DIR_LABEL[trip.direction])} · {trip.bus?.label ?? trip.bus?.plate}</T>
        <View style={s.row}>
          {(['boarded', 'expected', 'alighted'] as const).map((k) => (
            <Pill key={k} tone={k === 'boarded' ? 'blue' : k === 'expected' ? 'gray' : 'green'} text={`${tr(...RIDER_LABEL[k])}: ${riders.filter((r) => r.status === k).length}`} />
          ))}
        </View>
      </Card>

      {err != null && <ErrorView error={err} />}
      {(pending.events > 0 || pending.locations > 0) && (
        <Card style={{ backgroundColor: C.amberBg }}>
          <T style={{ color: C.amber }}>{tr(`بانتظار المزامنة: ${pending.events} حدث، ${pending.locations} موقع`, `Waiting to sync: ${pending.events} events, ${pending.locations} locations`)}</T>
        </Card>
      )}
      {rejected.length > 0 && (
        <Card style={{ backgroundColor: C.redBg }}>
          {rejected.map((r, i) => (
            <T key={i} style={{ color: C.red }}>{riders.find((x) => x.studentId === r.student_id)?.fullName}: {tr(...(REJECT_TEXT[r.code] ?? [r.code, r.code]))}</T>
          ))}
          <Btn kind="secondary" title={tr('حسنًا', 'OK')} onPress={async () => { await clearRejected(id); load(); sync(); }} />
        </Card>
      )}

      {trip.status === 'scheduled' && <Btn big title={tr('بدء الرحلة', 'Start trip')} busy={starting} onPress={startTrip} />}

      {active && (
        <>
          <Card style={{ borderColor: tracking ? C.green : C.amber, borderWidth: 2 }}>
            <T bold style={{ color: tracking ? C.greenDark : C.amber }}>
              {tracking ? tr('● مشاركة الموقع تعمل', '● Location sharing on') : tr('مشاركة الموقع متوقفة', 'Location sharing off')}
            </T>
            {!tracking && <Btn kind="warn" title={tr('إعادة تشغيل الموقع', 'Restart location')} onPress={async () => {
              const p = await ensureLocationPermissions();
              if (p === 'background' || p === 'foreground_only') { await startTracking(id, data.tracking.intervalSec); setTracking(true); }
              else Alert.alert(tr('الموقع غير متاح', 'Location unavailable'), tr('فعّل إذن الموقع من الإعدادات.', 'Enable location permission in Settings.'), [{ text: tr('الإعدادات', 'Settings'), onPress: () => Linking.openSettings() }, { text: tr('إغلاق', 'Close') }]);
            }} />}
          </Card>
          {nextStop && (
            <Card>
              <T muted>{tr('نقطة التوقف التالية', 'Next stop')}</T>
              <T bold size={22}>{nextStop.name}</T>
              <Btn big kind="secondary" title={tr('فتح الملاحة', 'Navigate')} onPress={() => openNavigation(nextStop.lat, nextStop.lng)} />
            </Card>
          )}
          <View style={s.row}>
            <Btn big kind="secondary" style={{ flex: 1 }} title={tr('مسح بطاقة QR', 'Scan QR')} onPress={() => router.push(`/driver/scan/${id}`)} />
            <Btn big kind="danger" style={{ flex: 1 }} title={tr('بلاغ / طوارئ', 'Report / SOS')} onPress={() => setReportOpen(true)} />
          </View>
        </>
      )}

      {byStop.map(({ stop, riders: rs }) => rs.length > 0 && (
        <Card key={stop.id}>
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <T bold size={17}>{stop.seq}. {stop.name}</T>
            {active && <Btn kind="ghost" title={tr('ملاحة', 'Navigate')} onPress={() => openNavigation(stop.lat, stop.lng)} />}
          </View>
          {rs.map((r) => (
            <View key={r.id} style={{ borderTopWidth: 1, borderColor: C.line, paddingVertical: 10, gap: 8 }}>
              <View style={[s.row, { justifyContent: 'space-between' }]}>
                <View style={{ flex: 1 }}>
                  <T size={18}>{r.fullName}</T>
                  {r.requiresHandover && <T size={13} style={{ color: C.amber }}>{tr('تسليم آمن: يُسلَّم لمستلم مصرّح له فقط', 'Safe handover: authorized receiver only')}</T>}
                </View>
                <Pill text={tr(...RIDER_LABEL[r.status])} tone={r.status === 'boarded' ? 'blue' : r.status === 'alighted' ? 'green' : r.status === 'expected' ? 'gray' : 'amber'} />
              </View>
              {active && (
                <View style={s.row}>
                  {(r.status === 'expected' || r.status === 'no_show' || r.status === 'absent') && <Btn big style={{ flex: 2 }} title={tr('صعد', 'Boarded')} onPress={() => record(r, 'boarded')} />}
                  {r.status === 'expected' && <Btn big kind="secondary" style={{ flex: 1 }} title={tr('لم يحضر', 'No-show')} onPress={() => record(r, 'no_show')} />}
                  {r.status === 'boarded' && <Btn big style={{ flex: 1 }} title={tr('نزل', 'Dropped off')} onPress={() => record(r, 'alighted')} />}
                </View>
              )}
            </View>
          ))}
        </Card>
      ))}

      {active && <Btn big kind="warn" title={tr('إنهاء الرحلة', 'End trip')} onPress={() => router.push(`/driver/end/${id}`)} />}
      {trip.status === 'completed' && trip.inspectionStatus === 'pending' && <Btn big kind="warn" title={tr('فحص خلو الباص', 'Bus-empty check')} onPress={() => router.push(`/driver/end/${id}`)} />}

      <HandoverSheet
        visible={handoverFor != null}
        studentName={handoverFor?.fullName ?? ''}
        receivers={handoverFor?.receivers ?? []}
        safety={data.safety}
        onClose={() => setHandoverFor(null)}
        onPick={(rcv) => { const r = handoverFor!; setHandoverFor(null); record(r, 'alighted', 'manual', rcv); }}
        onNoReceiver={async () => { await api('POST', `/driver/trips/${id}/riders/${handoverFor!.studentId}/no-receiver`, {}); }}
      />
      <ReportSheet visible={reportOpen} onClose={() => setReportOpen(false)} tripId={id} safety={data.safety} />
    </Screen>
  );
}

