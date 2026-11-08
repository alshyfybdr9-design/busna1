import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Btn, C, Card, Field, Screen, T, s, useLang } from '../components/ui';

/** البداية: رمز الجهة أو تسجيل الدخول مباشرة. الرمز يحدد الجهة فقط ولا يمنح أي وصول. */
export default function Welcome() {
  const { tr, lang, setLang } = useLang();
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  return (
    <Screen>
      <View style={{ paddingTop: 48, gap: 6 }}>
        <T bold size={30} style={{ color: C.greenDark }}>{tr('باصنا', 'Busna')}</T>
        <T muted>{tr('متابعة النقل المدرسي بأمان ووضوح', 'Safe, clear school transport')}</T>
      </View>
      <Card>
        <Field label={tr('رمز المدرسة أو شركة النقل', 'School / company code')} hint={tr('الرمز يحدد الجهة فقط، وستحتاج لتسجيل الدخول.', 'The code only identifies the organization; you still need to sign in.')}>
          <TextInput style={s.input} value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="DEMO01" />
        </Field>
        <Btn title={tr('متابعة', 'Continue')} disabled={code.trim().length < 4} onPress={() => router.push(`/t/${encodeURIComponent(code.trim().toUpperCase())}`)} />
      </Card>
      <Card>
        <Btn kind="secondary" title={tr('لدي حساب — تسجيل الدخول', 'I have an account — sign in')} onPress={() => router.push('/login')} />
      </Card>
      <Card>
        <Field label={tr('لديك رابط دعوة؟ الصقه هنا', 'Have an invite link? Paste it')} hint={tr('عادةً يفتح الرابط التطبيق مباشرة.', 'Usually the link opens the app directly.')}>
          <TextInput style={s.input} value={invite} onChangeText={setInvite} autoCapitalize="none" autoCorrect={false} />
        </Field>
        <Btn kind="secondary" title={tr('فتح الدعوة', 'Open invite')} disabled={!invite.includes('invite/')}
          onPress={() => router.push(`/invite/${invite.trim().split('invite/')[1].split(/[?#/]/)[0]}`)} />
      </Card>
      <Btn kind="ghost" title={lang === 'ar' ? 'English' : 'العربية'} onPress={() => setLang(lang === 'ar' ? 'en' : 'ar')} />
    </Screen>
  );
}
