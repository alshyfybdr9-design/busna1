import { useState } from 'react';
import { Linking, Modal, Platform, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { api } from '../lib/session';
import { Btn, C, Card, Screen, T, s, useLang } from './ui';

export function openNavigation(lat: number, lng: number) {
  const url = Platform.OS === 'ios' ? `maps://?daddr=${lat},${lng}&dirflg=d` : `google.navigation:q=${lat},${lng}`;
  Linking.openURL(url).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`));
}

/** بلاغات بخيارات جاهزة — بدون كتابة أثناء القيادة. أرقام الاتصال تظهر فورًا حتى بدون إنترنت. */
export function ReportSheet({ visible, onClose, tripId, safety }: { visible: boolean; onClose: () => void; tripId: string | null; safety: { emergencyNumber: string; supervisorPhone: string | null } }) {
  const { tr } = useLang();
  const [sent, setSent] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState(false);
  async function send(kind: 'emergency' | 'issue', category: string) {
    setSent(category);
    setSendErr(false);
    try {
      await api('POST', '/driver/report', { tripId, kind, category, clientEventId: Crypto.randomUUID() });
    } catch {
      setSendErr(true);
    }
  }
  const call = (n: string | null) => n && Linking.openURL(`tel:${n}`);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <T bold size={22}>{tr('بلاغ أو حالة طارئة', 'Report or emergency')}</T>
        <T muted>{tr('في الطوارئ: توقّف بأمان واتصل فورًا. البلاغ لا يغني عن الاتصال.', 'In an emergency: stop safely and call now. A report does not replace a call.')}</T>
        <Btn big kind="danger" title={`${tr('اتصال بالطوارئ', 'Call emergency')} ${safety.emergencyNumber}`} onPress={() => call(safety.emergencyNumber)} />
        {safety.supervisorPhone && <Btn big kind="warn" title={tr('اتصال بمسؤول النقل', 'Call transport supervisor')} onPress={() => call(safety.supervisorPhone)} />}
        <T bold>{tr('طوارئ', 'Emergency')}</T>
        <View style={s.row}>
          <Btn big kind="danger" style={{ flex: 1 }} title={tr('حادث', 'Accident')} onPress={() => send('emergency', 'accident')} />
          <Btn big kind="danger" style={{ flex: 1 }} title={tr('حالة طبية', 'Medical')} onPress={() => send('emergency', 'medical')} />
        </View>
        <Btn big kind="danger" title={tr('طفل داخل الباص / مفقود', 'Child left on bus / missing')} onPress={() => send('emergency', 'child_left_on_bus')} />
        <T bold>{tr('مشكلة تشغيلية', 'Operational issue')}</T>
        <View style={s.row}>
          <Btn big kind="secondary" style={{ flex: 1 }} title={tr('عطل', 'Breakdown')} onPress={() => send('issue', 'breakdown')} />
          <Btn big kind="secondary" style={{ flex: 1 }} title={tr('ازدحام/تأخير', 'Traffic/delay')} onPress={() => send('issue', 'traffic')} />
        </View>
        <Btn big kind="secondary" title={tr('سلوك طالب', 'Student behavior')} onPress={() => send('issue', 'student_behavior')} />
        {sent && !sendErr && <Card style={{ backgroundColor: C.greenBg }}><T style={{ color: C.greenDark }}>{tr('أُرسل البلاغ للمشرف.', 'Report sent to supervisor.')}</T></Card>}
        {sendErr && <Card style={{ backgroundColor: C.redBg }}><T style={{ color: C.red }}>{tr('تعذر إرسال البلاغ (لا اتصال). اتصل مباشرة بالأرقام أعلاه.', 'Could not send (offline). Call the numbers above.')}</T></Card>}
        <Btn title={tr('إغلاق', 'Close')} kind="ghost" onPress={() => { setSent(null); onClose(); }} />
      </Screen>
    </Modal>
  );
}

