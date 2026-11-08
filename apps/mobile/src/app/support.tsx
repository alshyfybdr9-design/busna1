import { Linking } from 'react-native';
import { api } from '../lib/session';
import { Btn, C, Card, ErrorView, Loading, Screen, T, useLang, usePolling } from '../components/ui';

/**
 * الدعم: بيانات التواصل الفعلية للجهة وأوقات الدعم كما حددتها الإدارة.
 * (المساعد الآلي وتذاكر الدعم تُضاف في مرحلة لاحقة.)
 */
export default function Support() {
  const { tr } = useLang();
  const me = usePolling(() => api('GET', '/me'), 0);
  if (me.loading && !me.data) return <Loading />;
  if (!me.data) return <Screen><ErrorView error={me.error} onRetry={me.reload} /></Screen>;
  const t = me.data.tenant;
  return (
    <Screen>
      <Card style={{ backgroundColor: C.redBg, borderColor: '#fecaca' }}>
        <T bold style={{ color: C.red }}>{tr('في حالة الطوارئ', 'In an emergency')}</T>
        <T style={{ color: C.red }}>{tr('إذا فُقد طفل أو يُشتبه ببقائه داخل الباص أو وقع حادث: اتصل فورًا بمسؤول النقل وبالطوارئ.', 'If a child is missing, may be left on the bus, or there is an accident: call the transport office and emergency services now.')}</T>
        <Btn big kind="danger" title={`${tr('الطوارئ', 'Emergency')} ${t.emergencyNumber}`} onPress={() => Linking.openURL(`tel:${t.emergencyNumber}`)} />
        {t.contactPhone && <Btn big kind="warn" title={tr('اتصال بمسؤول النقل', 'Call transport office')} onPress={() => Linking.openURL(`tel:${t.contactPhone}`)} />}
      </Card>
      <Card>
        <T bold size={18}>{t.name}</T>
        {t.supportHours ? <T>{tr('أوقات الدعم', 'Support hours')}: {t.supportHours}</T> : <T muted>{tr('لم تحدد الجهة أوقات الدعم.', 'Support hours not specified.')}</T>}
        {t.contactPhone && <Btn kind="secondary" title={`${tr('هاتف', 'Phone')}: ${t.contactPhone}`} onPress={() => Linking.openURL(`tel:${t.contactPhone}`)} />}
        {t.contactEmail && <Btn kind="secondary" title={`${tr('بريد', 'Email')}: ${t.contactEmail}`} onPress={() => Linking.openURL(`mailto:${t.contactEmail}`)} />}
        {!t.contactPhone && !t.contactEmail && <T muted>{tr('لا توجد بيانات تواصل مسجلة لدى الجهة.', 'No contact details on file.')}</T>}
      </Card>
    </Screen>
  );
}
