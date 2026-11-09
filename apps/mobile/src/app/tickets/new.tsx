import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../lib/session';
import { Btn, Card, ErrorView, Field, Screen, T, s, useLang } from '../../components/ui';
import { CATEGORIES } from '../../components/support';

/** تذكرة دعم جديدة — تعمل دائمًا حتى لو كان المساعد الآلي معطّلًا */
export default function NewTicket() {
  const { tr, lang } = useLang();
  const params = useLocalSearchParams<{ text?: string }>();
  const [category, setCategory] = useState('trip');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState(params.text ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const cat = CATEGORIES.find((c) => c.key === category)!;
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api('POST', '/support/tickets', { category, subject: subject.trim(), body: body.trim() });
      router.replace(`/tickets/${r.ticket.id}`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen>
      <Card>
        <Field label={tr('نوع المشكلة', 'Type')}>
          <View style={s.row}>{CATEGORIES.map((c) => (
            <Btn key={c.key} kind={category === c.key ? 'primary' : 'secondary'} title={lang === 'ar' ? c.ar : c.en} onPress={() => setCategory(c.key)} />
          ))}</View>
        </Field>
        <T muted size={13}>{cat.platform ? tr('ستصل إلى فريق دعم منصة باصنا.', 'Goes to Busna platform support.') : tr('ستصل إلى إدارة النقل في جهتك.', 'Goes to your transport office.')}</T>
        <Field label={tr('العنوان', 'Subject')}><TextInput style={s.input} value={subject} onChangeText={setSubject} maxLength={200} /></Field>
        <Field label={tr('التفاصيل', 'Details')}>
          <TextInput style={[s.input, { minHeight: 120, textAlignVertical: 'top' }]} value={body} onChangeText={setBody} multiline maxLength={5000} />
        </Field>
        {err != null && <ErrorView error={err} />}
        <Btn big title={tr('إرسال', 'Send')} busy={busy} disabled={subject.trim().length < 3 || body.trim().length < 3} onPress={submit} />
      </Card>
    </Screen>
  );
}
