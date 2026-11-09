import { Linking, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '../lib/session';
import { Btn, C, Card, ErrorView, Loading, Pill, Screen, T, s, timeText, useLang, usePolling } from '../components/ui';
import { TICKET_STATUS } from '../components/support';

/** الدعم: الطوارئ أولًا، ثم المساعد الآلي، ثم التذاكر والتواصل المباشر */
export default function Support() {
  const { tr, lang } = useLang();
  const info = usePolling(() => api('GET', '/support/info'), 0);
  const tickets = usePolling(() => api('GET', '/support/tickets'), 30_000);
  if (info.loading && !info.data) return <Loading />;
  if (!info.data) return <Screen><ErrorView error={info.error} onRetry={info.reload} /></Screen>;
  const t = info.data;
  return (
    <Screen onRefresh={() => Promise.all([info.refresh(), tickets.refresh()])}>
      <Card style={{ backgroundColor: C.redBg, borderColor: '#fecaca' }}>
        <T bold style={{ color: C.red }}>{tr('في حالة الطوارئ', 'In an emergency')}</T>
        <T style={{ color: C.red }}>{tr('إذا فُقد طفل أو يُشتبه ببقائه داخل الباص أو وقع حادث: اتصل فورًا بمسؤول النقل وبالطوارئ.', 'If a child is missing, may be left on the bus, or there is an accident: call the transport office and emergency services now.')}</T>
        <Btn big kind="danger" title={`${tr('الطوارئ', 'Emergency')} ${t.emergencyNumber}`} onPress={() => Linking.openURL(`tel:${t.emergencyNumber}`)} />
        {t.contactPhone && <Btn big kind="warn" title={tr('اتصال بمسؤول النقل', 'Call transport office')} onPress={() => Linking.openURL(`tel:${t.contactPhone}`)} />}
      </Card>

      <Card>
        <T bold size={18}>{tr('مساعد باصنا', 'Busna Assistant')}</T>
        <T muted size={14}>{tr('مساعد آلي يجيب من بيانات حسابك وسياسات الجهة، ويحوّلك لموظف متى شئت.', 'An automated assistant using your account data and the organization\'s policies; hand off to a person anytime.')}</T>
        <Btn big title={tr('اسأل المساعد', 'Ask the assistant')} onPress={() => router.push('/assistant')} />
      </Card>

      <Card>
        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <T bold size={18}>{tr('تذاكري', 'My tickets')}</T>
          <Btn kind="secondary" title={tr('تحدث مع موظف', 'Talk to a person')} onPress={() => router.push('/tickets/new')} />
        </View>
        {tickets.data?.tickets.length === 0 && <T muted>{tr('لا توجد تذاكر.', 'No tickets.')}</T>}
        {tickets.data?.tickets.map((x: any) => (
          <Pressable key={x.id} onPress={() => router.push(`/tickets/${x.id}`)} style={{ borderTopWidth: 1, borderColor: C.line, paddingVertical: 10 }}>
            <View style={[s.row, { justifyContent: 'space-between' }]}>
              <T>#{x.ref} {x.subject}</T>
              <Pill tone={TICKET_STATUS[x.status]?.[2] ?? 'gray'} text={tr(TICKET_STATUS[x.status]?.[0] ?? x.status, TICKET_STATUS[x.status]?.[1] ?? x.status)} />
            </View>
            <T muted size={13}>{x.queue === 'platform' ? tr('دعم منصة باصنا', 'Busna support') : tr('إدارة النقل', 'Transport office')} · {timeText(x.lastActivityAt, lang)}</T>
          </Pressable>
        ))}
      </Card>

      <Card>
        <T bold size={18}>{t.name}</T>
        {t.supportHours ? <T>{tr('أوقات الدعم', 'Support hours')}: {t.supportHours}</T> : <T muted>{tr('لم تحدد الجهة أوقات الدعم.', 'Support hours not specified.')}</T>}
        {t.contactPhone && <Btn kind="secondary" title={`${tr('هاتف', 'Phone')}: ${t.contactPhone}`} onPress={() => Linking.openURL(`tel:${t.contactPhone}`)} />}
        {t.contactEmail && <Btn kind="secondary" title={`${tr('بريد', 'Email')}: ${t.contactEmail}`} onPress={() => Linking.openURL(`mailto:${t.contactEmail}`)} />}
      </Card>
    </Screen>
  );
}
