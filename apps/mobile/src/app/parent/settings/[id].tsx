import { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '../../../lib/session';
import { Btn, C, Card, ErrorView, Field, Loading, Pill, Screen, T, s, useLang, usePolling } from '../../../components/ui';

const DISTANCES = [500, 1000, 2000, 3000];

/** إعدادات الطفل: مسافة تنبيه «الباص اقترب» + الأشخاص المصرّح لهم باستلامه */
export default function ChildSettings() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { tr } = useLang();
  const q = usePolling(() => api('GET', `/parent/children/${id}/settings`), 0, [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [f, setF] = useState({ fullName: '', relationship: '', phone: '' });

  async function setApproach(meters: number | null) {
    setBusy('approach');
    setErr(null);
    try {
      await api('PUT', `/parent/children/${id}/approach`, { meters });
      await q.refresh();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }
  async function addPickup() {
    setBusy('add');
    setErr(null);
    try {
      await api('POST', `/parent/children/${id}/pickups`, {
        fullName: f.fullName.trim(),
        relationship: f.relationship.trim() || null,
        phone: f.phone.trim() || null,
      });
      setF({ fullName: '', relationship: '', phone: '' });
      await q.refresh();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }
  function revoke(p: any) {
    Alert.alert(tr('إلغاء التصريح', 'Revoke'), tr(`لن يتمكن ${p.fullName} من استلام الطالب. متابعة؟`, `${p.fullName} will no longer be able to receive the child. Continue?`), [
      { text: tr('رجوع', 'Back'), style: 'cancel' },
      { text: tr('إلغاء التصريح', 'Revoke'), style: 'destructive', onPress: async () => {
        try { await api('POST', `/parent/pickups/${p.id}/revoke`, {}); await q.refresh(); } catch (e) { setErr(e); }
      } },
    ]);
  }

  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <Screen><ErrorView error={q.error} onRetry={q.reload} /></Screen>;
  const { child, approach, pickups } = q.data;
  return (
    <Screen onRefresh={q.refresh}>
      <T bold size={22}>{child.fullName}</T>
      {err != null && <ErrorView error={err} />}

      <Card>
        <T bold>{tr('تنبيه «الباص اقترب»', '"Bus approaching" alert')}</T>
        <T muted size={14}>{tr('يصلك إشعار مرة واحدة في كل رحلة عندما يقترب الباص من نقطة الصعود (الذهاب) أو من المنزل (العودة).', 'You get one notification per trip when the bus nears the pickup stop (morning) or home (afternoon).')}</T>
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          {DISTANCES.map((m) => (
            <Btn key={m} kind={approach.meters === m ? 'primary' : 'secondary'} disabled={busy === 'approach'}
              title={m >= 1000 ? `${m / 1000} ${tr('كم', 'km')}` : `${m} ${tr('م', 'm')}`} onPress={() => setApproach(m)} />
          ))}
          <Btn kind={approach.meters == null ? 'primary' : 'secondary'} disabled={busy === 'approach'} title={tr('إيقاف', 'Off')} onPress={() => setApproach(null)} />
        </View>
        {!approach.custom && <T muted size={13}>{tr('الإعداد الحالي هو الافتراضي من إدارة النقل.', 'Currently using the transport office default.')}</T>}
        <T muted size={13}>{tr('المسافة ووقت الوصول تقريبيان ويعتمدان على وصول موقع الباص.', 'Distance and arrival time are approximate and depend on the bus location updates.')}</T>
      </Card>

      <Card>
        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <T bold>{tr('المصرّح لهم باستلام الطفل', 'People allowed to receive the child')}</T>
          {child.requiresHandover ? <Pill tone="amber" text={tr('تسليم آمن مفعّل', 'Safe handover on')} /> : <Pill tone="gray" text={tr('غير مفعّل', 'Off')} />}
        </View>
        <T muted size={14}>
          {child.requiresHandover
            ? tr('في رحلة العودة لا يُنزَّل طفلك إلا بعد أن يختار السائق من استلمه: أنت (وأولياء الأمور المسجلون) أو أحد الأشخاص أدناه. إن لم يوجد أحد يبقى الطفل في الباص ويصلك إشعار.', 'On the way home, your child is dropped off only after the driver picks who received them: you (and registered guardians) or someone below. If nobody is there, the child stays on the bus and you are notified.')
            : tr('تفعيل التسليم الآمن يتم من إدارة النقل (عادةً للصغار). يمكنك تجهيز القائمة الآن.', 'Safe handover is enabled by the transport office (usually for young children). You can prepare the list now.')}
        </T>
        <T muted size={13}>{tr('يرى السائق الاسم وصلة القرابة فقط.', 'The driver sees only the name and relationship.')}</T>
        {pickups.length === 0 && <T muted>{tr('لم تُضف أحدًا بعد.', 'Nobody added yet.')}</T>}
        {pickups.map((p: any) => (
          <View key={p.id} style={[s.row, { justifyContent: 'space-between', borderTopWidth: 1, borderColor: C.line, paddingTop: 8 }]}>
            <View style={{ flex: 1 }}>
              <T>{p.fullName}</T>
              <T muted size={13}>{[p.relationship, p.phone].filter(Boolean).join(' · ')}</T>
            </View>
            <Btn kind="ghost" title={tr('إلغاء', 'Revoke')} onPress={() => revoke(p)} />
          </View>
        ))}
      </Card>

      {pickups.length < 6 && (
        <Card>
          <T bold>{tr('إضافة شخص مصرّح له', 'Add an authorized person')}</T>
          <Field label={tr('الاسم الكامل', 'Full name')}>
            <TextInput style={s.input} value={f.fullName} onChangeText={(v) => setF({ ...f, fullName: v })} maxLength={120} />
          </Field>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Field label={tr('صلة القرابة', 'Relationship')}>
                <TextInput style={s.input} value={f.relationship} onChangeText={(v) => setF({ ...f, relationship: v })} maxLength={40} placeholder={tr('مثال: عم، جدة، سائق العائلة', 'e.g. uncle, grandmother')} />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label={tr('الجوال (اختياري)', 'Phone (optional)')}>
                <TextInput style={s.input} value={f.phone} onChangeText={(v) => setF({ ...f, phone: v })} keyboardType="phone-pad" />
              </Field>
            </View>
          </View>
          <Btn title={tr('إضافة', 'Add')} busy={busy === 'add'} disabled={f.fullName.trim().length < 2} onPress={addPickup} />
        </Card>
      )}
    </Screen>
  );
}
