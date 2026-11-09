import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '../../lib/session';
import { Btn, C, Card, ErrorView, Loading, Pill, Screen, T, s, timeText, useLang, usePolling } from '../../components/ui';
import { TICKET_STATUS } from '../../components/support';

export default function TicketDetail() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { tr, lang } = useLang();
  const q = usePolling(() => api('GET', `/support/tickets/${id}`), 20_000, [id]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <Screen><ErrorView error={q.error} onRetry={q.reload} /></Screen>;
  const { ticket: t, messages } = q.data;
  const st = TICKET_STATUS[t.status];
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await q.refresh();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen onRefresh={q.refresh}>
      <Card>
        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <T bold size={18}>#{t.ref}</T>
          <Pill tone={st?.[2] ?? 'gray'} text={tr(st?.[0] ?? t.status, st?.[1] ?? t.status)} />
        </View>
        <T bold>{t.subject}</T>
        <T muted size={13}>{t.queue === 'platform' ? tr('لدى دعم منصة باصنا', 'With Busna support') : tr('لدى إدارة النقل', 'With the transport office')}</T>
      </Card>
      {messages.map((m: any) => (
        <Card key={m.id} style={m.authorKind === 'agent' ? { backgroundColor: C.greenBg, borderColor: '#bbf7d0' } : undefined}>
          <T bold size={13}>{m.authorKind === 'agent' ? tr('فريق الدعم', 'Support team') : tr('أنت', 'You')} · {timeText(m.createdAt, lang)}</T>
          <T>{m.body}</T>
        </Card>
      ))}
      {err != null && <ErrorView error={err} />}
      {t.status !== 'closed' && (
        <Card>
          <TextInput style={[s.input, { minHeight: 80, textAlignVertical: 'top' }]} value={reply} onChangeText={setReply} multiline placeholder={tr('اكتب ردك…', 'Write a reply…')} />
          <Btn title={tr('إرسال', 'Send')} busy={busy} disabled={!reply.trim()} onPress={() => act(async () => { await api('POST', `/support/tickets/${id}/messages`, { body: reply.trim() }); setReply(''); })} />
          <Btn kind="ghost" title={tr('إغلاق التذكرة', 'Close ticket')} onPress={() => act(() => api('PATCH', `/support/tickets/${id}`, { status: 'closed' }))} />
        </Card>
      )}
    </Screen>
  );
}
