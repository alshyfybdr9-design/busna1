import { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '../../lib/session';
import { Btn, Card, DIR_LABEL, ErrorView, Field, Pill, Screen, T, s, useLang, usePolling } from '../../components/ui';

function dateIn(days: number) {
  const d = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(d);
}

const STATUS: Record<string, [string, string, 'green' | 'amber' | 'red' | 'gray']> = {
  pending: ['قيد المراجعة', 'Pending', 'amber'], approved: ['معتمد', 'Approved', 'green'], rejected: ['مرفوض', 'Rejected', 'red'], cancelled: ['ملغى', 'Cancelled', 'gray'],
};

/** طلب غياب: يحدد الطفل والتاريخ والرحلة ثم يطلب تأكيدًا قبل الإرسال */
export default function Absence() {
  const { studentId } = useLocalSearchParams<{ studentId?: string }>();
  const { tr } = useLang();
  const kids = usePolling(() => api('GET', '/parent/children'), 0);
  const list = usePolling(() => api('GET', '/parent/absences'), 0);
  const [child, setChild] = useState<string | undefined>(studentId);
  const [date, setDate] = useState(dateIn(1));
  const [direction, setDirection] = useState<'both' | 'to_school' | 'from_school'>('both');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const childName = kids.data?.children.find((c: any) => c.id === child)?.fullName;

  function confirm() {
    Alert.alert(tr('تأكيد طلب الغياب', 'Confirm absence'), `${childName}\n${date}\n${tr(...DIR_LABEL[direction])}`, [
      { text: tr('إلغاء', 'Cancel'), style: 'cancel' },
      { text: tr('تأكيد', 'Confirm'), onPress: submit },
    ]);
  }
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api('POST', '/parent/absences', { studentId: child, date, direction, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setDone(r.absence.status);
      list.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    try {
      await api('POST', `/parent/absences/${id}/cancel`, {});
      list.reload();
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <Screen>
      <Card>
        <Field label={tr('الطفل', 'Child')}>
          <View style={s.row}>{(kids.data?.children ?? []).map((c: any) => (
            <Btn key={c.id} kind={child === c.id ? 'primary' : 'secondary'} title={c.fullName} onPress={() => setChild(c.id)} />
          ))}</View>
        </Field>
        <Field label={tr('التاريخ', 'Date')} hint="YYYY-MM-DD">
          <View style={s.row}>
            <Btn kind={date === dateIn(0) ? 'primary' : 'secondary'} title={tr('اليوم', 'Today')} onPress={() => setDate(dateIn(0))} />
            <Btn kind={date === dateIn(1) ? 'primary' : 'secondary'} title={tr('غدًا', 'Tomorrow')} onPress={() => setDate(dateIn(1))} />
          </View>
          <TextInput style={s.input} value={date} onChangeText={setDate} keyboardType="numbers-and-punctuation" />
        </Field>
        <Field label={tr('الرحلة', 'Trip')}>
          <View style={s.row}>{(['both', 'to_school', 'from_school'] as const).map((d) => (
            <Btn key={d} kind={direction === d ? 'primary' : 'secondary'} title={tr(...DIR_LABEL[d])} onPress={() => setDirection(d)} />
          ))}</View>
        </Field>
        <Field label={tr('السبب (اختياري)', 'Reason (optional)')}>
          <TextInput style={s.input} value={reason} onChangeText={setReason} maxLength={300} />
        </Field>
        {err != null && <ErrorView error={err} />}
        {done && <Pill text={done === 'approved' ? tr('تم تسجيل الغياب واعتماده', 'Absence recorded and approved') : tr('أُرسل الطلب وهو قيد المراجعة', 'Request sent for review')} />}
        <Btn big title={tr('إرسال الطلب', 'Submit')} busy={busy} disabled={!child || !/^\d{4}-\d{2}-\d{2}$/.test(date)} onPress={confirm} />
      </Card>
      <T bold>{tr('طلباتي', 'My requests')}</T>
      {(list.data?.absences ?? []).map((a: any) => (
        <Card key={a.id}>
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <T>{a.studentName} · {a.date} · {tr(...DIR_LABEL[a.direction])}</T>
            <Pill tone={STATUS[a.status][2]} text={tr(STATUS[a.status][0], STATUS[a.status][1])} />
          </View>
          {(a.status === 'pending' || a.status === 'approved') && a.date >= dateIn(0) && (
            <Btn kind="ghost" title={tr('إلغاء الطلب', 'Cancel request')} onPress={() => cancel(a.id)} />
          )}
        </Card>
      ))}
    </Screen>
  );
}
