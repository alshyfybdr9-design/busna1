import { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { api } from '../../lib/session';
import { Btn, Card, DIR_LABEL, ErrorView, Field, Pill, Screen, T, s, useLang, usePolling } from '../../components/ui';

function dateIn(days: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date(Date.now() + days * 86400000));
}
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

const STATUS: Record<string, [string, string, 'green' | 'amber' | 'red' | 'gray']> = {
  pending: ['قيد المراجعة', 'Pending', 'amber'], approved: ['معتمد', 'Approved', 'green'], rejected: ['مرفوض', 'Rejected', 'red'], cancelled: ['ملغى', 'Cancelled', 'gray'],
};

/** طلب تغيير عنوان/نقطة توقف: دائم أو مؤقت (حتى 60 يومًا). الإدارة تراجع وتحدد نقطة التوقف. */
export default function AddressChange() {
  const { studentId } = useLocalSearchParams<{ studentId?: string }>();
  const { tr } = useLang();
  const kids = usePolling(() => api('GET', '/parent/children'), 0);
  const list = usePolling(() => api('GET', '/parent/stop-changes'), 0);
  const [child, setChild] = useState<string | undefined>(studentId);
  const [kind, setKind] = useState<'temporary' | 'permanent'>('temporary');
  const [direction, setDirection] = useState<'both' | 'to_school' | 'from_school'>('both');
  const [start, setStart] = useState(dateIn(1));
  const [end, setEnd] = useState(dateIn(7));
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState(false);

  async function useMyLocation() {
    setLocating(true);
    try {
      const p = await Location.requestForegroundPermissionsAsync();
      if (p.status !== 'granted') {
        Alert.alert(tr('الموقع غير متاح', 'Location unavailable'), tr('لم يُسمح بالوصول للموقع. يمكنك كتابة العنوان فقط.', 'Location not allowed. You can type the address only.'));
        return;
      }
      const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setCoords({ lat: Number(l.coords.latitude.toFixed(6)), lng: Number(l.coords.longitude.toFixed(6)) });
    } catch {
      Alert.alert(tr('تعذر تحديد الموقع', 'Could not get location'), tr('تأكد من تفعيل خدمات الموقع.', 'Make sure location services are on.'));
    } finally {
      setLocating(false);
    }
  }

  const childName = kids.data?.children.find((c: any) => c.id === child)?.fullName;
  const valid = !!child && address.trim().length >= 3 && isDate(start) && (kind === 'permanent' || (isDate(end) && end >= start));

  function confirm() {
    const period = kind === 'temporary' ? `${start} ← ${end}` : `${tr('ابتداءً من', 'From')} ${start}`;
    Alert.alert(tr('تأكيد الطلب', 'Confirm request'), `${childName}\n${kind === 'temporary' ? tr('مؤقت', 'Temporary') : tr('دائم', 'Permanent')} · ${tr(...DIR_LABEL[direction])}\n${period}\n${address.trim()}`, [
      { text: tr('رجوع', 'Back'), style: 'cancel' },
      { text: tr('إرسال', 'Send'), onPress: submit },
    ]);
  }
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/parent/stop-changes', {
        studentId: child, kind, direction, startDate: start, endDate: kind === 'temporary' ? end : null,
        address: address.trim(), note: note.trim() || null, ...(coords ? coords : {}),
      });
      setSent(true);
      setAddress('');
      setNote('');
      setCoords(null);
      list.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    try {
      await api('POST', `/parent/stop-changes/${id}/cancel`, {});
      list.reload();
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <Screen>
      <Card>
        <T muted size={14}>{tr('مثال: الطفل سيقيم عند الجد أسبوعًا، أو انتقلتم لمنزل جديد. تراجع إدارة النقل الطلب وتحدد نقطة التوقف المناسبة، ويصلك إشعار بالقرار.', 'E.g. staying with grandparents for a week, or you moved. The transport office reviews and picks a stop; you will be notified.')}</T>
        <Field label={tr('الطفل', 'Child')}>
          <View style={[s.row, { flexWrap: 'wrap' }]}>{(kids.data?.children ?? []).map((c: any) => (
            <Btn key={c.id} kind={child === c.id ? 'primary' : 'secondary'} title={c.fullName} onPress={() => setChild(c.id)} />
          ))}</View>
        </Field>
        <Field label={tr('نوع التغيير', 'Change type')}>
          <View style={s.row}>
            <Btn style={{ flex: 1 }} kind={kind === 'temporary' ? 'primary' : 'secondary'} title={tr('مؤقت', 'Temporary')} onPress={() => setKind('temporary')} />
            <Btn style={{ flex: 1 }} kind={kind === 'permanent' ? 'primary' : 'secondary'} title={tr('دائم', 'Permanent')} onPress={() => setKind('permanent')} />
          </View>
        </Field>
        <Field label={tr('الرحلة', 'Trip')}>
          <View style={[s.row, { flexWrap: 'wrap' }]}>{(['both', 'to_school', 'from_school'] as const).map((d) => (
            <Btn key={d} kind={direction === d ? 'primary' : 'secondary'} title={tr(...DIR_LABEL[d])} onPress={() => setDirection(d)} />
          ))}</View>
        </Field>
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Field label={kind === 'temporary' ? tr('من تاريخ', 'From') : tr('ابتداءً من', 'Starting')} hint="YYYY-MM-DD">
              <TextInput style={s.input} value={start} onChangeText={setStart} keyboardType="numbers-and-punctuation" />
            </Field>
          </View>
          {kind === 'temporary' && (
            <View style={{ flex: 1 }}>
              <Field label={tr('إلى تاريخ', 'To')} hint={tr('حتى 60 يومًا', 'Up to 60 days')}>
                <TextInput style={s.input} value={end} onChangeText={setEnd} keyboardType="numbers-and-punctuation" />
              </Field>
            </View>
          )}
        </View>
        <Field label={tr('العنوان الجديد', 'New address')}>
          <TextInput style={[s.input, { minHeight: 70 }]} multiline value={address} onChangeText={setAddress} maxLength={300}
            placeholder={tr('الحي، الشارع، أقرب معلم', 'District, street, nearest landmark')} />
        </Field>
        <Btn kind="secondary" busy={locating} title={coords ? tr('✓ تم إرفاق موقعي الحالي', '✓ Current location attached') : tr('إرفاق موقعي الحالي (إن كنت في العنوان الجديد)', 'Attach my current location (if at the new address)')} onPress={useMyLocation} />
        {coords && <Btn kind="ghost" title={tr('إزالة الموقع', 'Remove location')} onPress={() => setCoords(null)} />}
        <Field label={tr('ملاحظة (اختياري)', 'Note (optional)')}>
          <TextInput style={s.input} value={note} onChangeText={setNote} maxLength={300} />
        </Field>
        {err != null && <ErrorView error={err} />}
        {sent && <Pill text={tr('أُرسل الطلب وهو قيد المراجعة', 'Request sent for review')} />}
        <Btn big title={tr('إرسال الطلب', 'Submit')} busy={busy} disabled={!valid} onPress={confirm} />
      </Card>

      <T bold>{tr('طلباتي', 'My requests')}</T>
      {(list.data?.requests ?? []).length === 0 && <T muted>{tr('لا توجد طلبات', 'No requests')}</T>}
      {(list.data?.requests ?? []).map((r: any) => (
        <Card key={r.id}>
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <T bold>{r.studentName}</T>
            <Pill tone={STATUS[r.status][2]} text={tr(STATUS[r.status][0], STATUS[r.status][1])} />
          </View>
          <T size={14}>{r.kind === 'temporary' ? tr('مؤقت', 'Temporary') : tr('دائم', 'Permanent')} · {tr(...DIR_LABEL[r.direction])} · {r.startDate}{r.endDate ? ` ← ${r.endDate}` : ''}</T>
          <T muted size={14}>{r.address}</T>
          {r.reviewNote && <T size={14}>{tr('ملاحظة الإدارة', 'Office note')}: {r.reviewNote}</T>}
          {r.status === 'pending' && <Btn kind="ghost" title={tr('إلغاء الطلب', 'Cancel request')} onPress={() => cancel(r.id)} />}
        </Card>
      ))}
    </Screen>
  );
}
