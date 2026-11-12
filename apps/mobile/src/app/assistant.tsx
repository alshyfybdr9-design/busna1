import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, TextInput, View, type ScrollViewInstance } from 'react-native';
import { router } from 'expo-router';
import { api } from '../lib/session';
import { useSession } from '../lib/SessionContext';
import { currentMembership } from '../lib/session';
import { BusMap } from '../components/BusMap';
import { Btn, C, ErrorView, OfflineBanner, Pill, T, ageText, s, useLang } from '../components/ui';

type Msg = {
  role: 'user' | 'assistant';
  text: string;
  mode?: 'ai' | 'fallback' | 'emergency' | 'system';
  cards?: any[];
  actions?: Array<{ id: string; summary: string }>;
  offerTicket?: boolean;
};

/** «مساعد باصنا»: مساعد آلي — لا ينفّذ أي إجراء إلا بعد ضغط المستخدم «تأكيد» */
export default function Assistant() {
  const { tr, lang } = useLang();
  const { session } = useSession();
  const role = currentMembership(session)?.role;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [decided, setDecided] = useState<Record<string, 'confirmed' | 'cancelled' | 'busy'>>({});
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50); }, [messages, busy]);

  async function send(t: string) {
    if (!t.trim() || busy) return;
    setErr(null);
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', text: t.trim() }]);
    setText('');
    try {
      const r = await api('POST', '/assistant/messages', { text: t.trim(), ...(conversationId ? { conversationId } : {}) });
      setConversationId(r.conversationId);
      setMessages((m) => [...m, r.reply]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, d: 'confirm' | 'cancel') {
    setDecided((x) => ({ ...x, [id]: 'busy' }));
    try {
      const r = await api('POST', `/assistant/actions/${id}/${d}`, {});
      setDecided((x) => ({ ...x, [id]: r.status }));
      setMessages((m) => [...m, { role: 'assistant', mode: 'system', text: r.message ?? tr('تم الإلغاء.', 'Cancelled.') }]);
    } catch (e) {
      setDecided((x) => { const n = { ...x }; delete n[id]; return n; });
      setErr(e);
    }
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';
  const suggestions = role === 'driver' || role === 'attendant'
    ? [tr('ما معلومات رحلتي الحالية؟', 'My current trip?'), tr('كيف أبدأ الرحلة؟', 'How do I start a trip?'), tr('انقطع الإنترنت، ماذا أفعل؟', 'Lost internet, what now?')]
    : role === 'parent'
      ? [tr('وين باص ولدي؟', "Where is my child's bus?"), tr('هل بنتي ركبت الباص؟', 'Did my daughter board?'), tr('أبي أبلغ عن غياب بكرة', 'Report an absence tomorrow')]
      : [tr('لخص الرحلات المتأخرة اليوم', 'Summarize late trips'), tr('كم تذكرة مفتوحة؟', 'Open tickets?')];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <OfflineBanner />
      <View style={{ padding: 12, gap: 6, borderBottomWidth: 1, borderColor: C.line, backgroundColor: C.white }}>
        <T muted size={13}>{tr('مساعد آلي وليس موظفًا. يعتمد على بيانات حسابك وسياسات الجهة فقط.', 'An automated assistant, not a person. Uses only your account data and the organization\'s policies.')}</T>
        {role === 'driver' && <T size={13} style={{ color: C.red }}>{tr('لا تكتب أثناء القيادة — توقف في مكان آمن أولًا.', "Don't type while driving — stop safely first.")}</T>}
        <View style={s.row}>
          <Btn kind="secondary" title={tr('تحدث مع موظف', 'Talk to a person')} onPress={() => router.push({ pathname: '/tickets/new', params: { text: lastUser } })} />
          {messages.length > 0 && <Btn kind="ghost" title={tr('محادثة جديدة', 'New chat')} onPress={() => { setConversationId(null); setMessages([]); setDecided({}); }} />}
        </View>
      </View>
      <ScrollView ref={scroll} contentContainerStyle={{ padding: 12, gap: 10 }} keyboardShouldPersistTaps="handled">
        {messages.length === 0 && (
          <View style={{ gap: 8 }}>
            {suggestions.map((sg) => <Btn key={sg} kind="secondary" title={sg} onPress={() => send(sg)} />)}
          </View>
        )}
        {messages.map((m, i) => (
          <View key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', borderRadius: 14, padding: 12, gap: 8,
            backgroundColor: m.role === 'user' ? C.green : m.mode === 'emergency' ? C.redBg : m.mode === 'fallback' ? C.amberBg : m.mode === 'system' ? C.greenBg : C.white,
            borderWidth: m.role === 'user' ? 0 : 1, borderColor: m.mode === 'emergency' ? '#fecaca' : C.line,
          }}>
            <T style={{ color: m.role === 'user' ? C.white : C.ink }}>{m.text}</T>
            {(m.cards ?? []).map((c, j) => <CardView key={j} card={c} lang={lang} tr={tr} />)}
            {(m.actions ?? []).map((a) => (
              <View key={a.id} style={{ gap: 6, borderTopWidth: 1, borderColor: C.line, paddingTop: 8 }}>
                <T bold size={14}>{a.summary}</T>
                {decided[a.id] && decided[a.id] !== 'busy'
                  ? <Pill tone={decided[a.id] === 'confirmed' ? 'green' : 'gray'} text={decided[a.id] === 'confirmed' ? tr('تم التأكيد', 'Confirmed') : tr('أُلغي', 'Cancelled')} />
                  : (
                    <View style={s.row}>
                      <Btn title={tr('تأكيد', 'Confirm')} busy={decided[a.id] === 'busy'} onPress={() => decide(a.id, 'confirm')} style={{ flex: 1 }} />
                      <Btn kind="ghost" title={tr('إلغاء', 'Cancel')} onPress={() => decide(a.id, 'cancel')} />
                    </View>
                  )}
              </View>
            ))}
            {m.offerTicket && <Btn kind="secondary" title={tr('إنشاء تذكرة دعم', 'Open a support ticket')} onPress={() => router.push({ pathname: '/tickets/new', params: { text: lastUser } })} />}
          </View>
        ))}
        {busy && <T muted>{tr('يكتب…', 'Typing…')}</T>}
        {err != null && <ErrorView error={err} />}
      </ScrollView>
      <View style={[s.row, { padding: 10, backgroundColor: C.white, borderTopWidth: 1, borderColor: C.line, flexWrap: 'nowrap' }]}>
        <TextInput style={[s.input, { flex: 1 }]} value={text} onChangeText={setText} placeholder={tr('اكتب سؤالك…', 'Ask a question…')} maxLength={2000} onSubmitEditing={() => send(text)} returnKeyType="send" />
        <Btn title={tr('إرسال', 'Send')} disabled={!text.trim() || busy} onPress={() => send(text)} />
      </View>
    </KeyboardAvoidingView>
  );
}

function CardView({ card, lang, tr }: { card: any; lang: 'ar' | 'en'; tr: (a: string, e: string) => string }) {
  const call = (n: string) => Linking.openURL(`tel:${n}`);
  switch (card.type) {
    case 'location':
      return (
        <View style={{ gap: 6 }}>
          <Pill tone={card.isStale ? 'amber' : 'green'} text={card.isStale ? `${tr('آخر تحديث', 'Last update')} ${ageText(card.ageSeconds, lang)}` : `● ${tr('مباشر', 'Live')} · ${ageText(card.ageSeconds, lang)}`} />
          <BusMap bus={{ lat: card.lat, lng: card.lng, isStale: card.isStale }} />
        </View>
      );
    case 'emergency':
      return (
        <View style={{ gap: 6 }}>
          <Btn big kind="danger" title={`${tr('الطوارئ', 'Emergency')} ${card.emergencyNumber}`} onPress={() => call(card.emergencyNumber)} />
          {card.phone && <Btn big kind="warn" title={tr('اتصال بمسؤول النقل', 'Call transport office')} onPress={() => call(card.phone)} />}
        </View>
      );
    case 'contact':
      return (
        <View style={{ gap: 6 }}>
          {card.phone && <Btn kind="secondary" title={`${tr('اتصال', 'Call')} ${card.phone}`} onPress={() => call(card.phone)} />}
          {card.supportHours && <T muted size={13}>{tr('أوقات الدعم', 'Support hours')}: {card.supportHours}</T>}
        </View>
      );
    case 'tickets':
      return (
        <View style={{ gap: 4 }}>
          {card.items.map((t: any) => (
            <Pressable key={t.id} onPress={() => router.push(`/tickets/${t.id}`)}><T size={14} style={{ color: C.greenDark }}>#{t.ref} {t.subject}</T></Pressable>
          ))}
        </View>
      );
    case 'knowledge':
      return <T muted size={13}>📄 {card.items.map((x: any) => x.title).join(' · ')}</T>;
    default:
      return null;
  }
}
