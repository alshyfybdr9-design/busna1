import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { acceptInvite, ApiError, publicApi } from '../../lib/session';
import { Btn, Card, ErrorView, Field, Loading, Screen, T, s, useLang } from '../../components/ui';
import { TenantHeader } from '../../components/auth';

const ROLE: Record<string, [string, string]> = {
  driver: ['سائق', 'Driver'], parent: ['ولي أمر', 'Parent'], supervisor: ['مشرف نقل', 'Supervisor'], tenant_admin: ['مدير الجهة', 'Admin'],
};

/** فتح رابط الدعوة في التطبيق: تسجيل حساب جديد أو ربط حساب موجود. المعاينة لا تعرض بيانات شخصية. */
export default function Invite() {
  const { token = '' } = useLocalSearchParams<{ token: string }>();
  const { tr, lang } = useLang();
  const [inv, setInv] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [f, setF] = useState({ fullName: '', email: '', phone: '', password: '', identifier: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    publicApi.invitePreview(token).then((r) => setInv(r.invite), setLoadErr);
  }, [token]);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = mode === 'register'
        ? { mode, fullName: f.fullName, password: f.password, ...(f.email ? { email: f.email.trim() } : {}), ...(f.phone ? { phone: f.phone.trim() } : {}) }
        : { mode, identifier: f.identifier.trim(), password: f.password };
      await acceptInvite(token, body);
      router.replace('/');
    } catch (e) {
      setErr(e);
      if (e instanceof ApiError && e.code === 'account_exists') setMode('login');
    } finally {
      setBusy(false);
    }
  }

  if (loadErr) return <Screen><ErrorView error={loadErr} /></Screen>;
  if (!inv) return <Loading />;
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Screen>
      <TenantHeader name={lang === 'en' && inv.tenant.nameEn ? inv.tenant.nameEn : inv.tenant.name} logoUrl={inv.tenant.logoUrl} />
      <T>{tr('دعوة للانضمام بدور:', 'Invited as:')} <T bold>{tr(...(ROLE[inv.role] ?? [inv.role, inv.role]))}</T></T>
      <View style={s.row}>
        <Btn kind={mode === 'register' ? 'primary' : 'secondary'} title={tr('حساب جديد', 'New account')} onPress={() => setMode('register')} style={{ flex: 1 }} />
        <Btn kind={mode === 'login' ? 'primary' : 'secondary'} title={tr('لدي حساب', 'I have an account')} onPress={() => setMode('login')} style={{ flex: 1 }} />
      </View>
      <Card>
        {mode === 'register' ? (
          <>
            <Field label={tr('الاسم الكامل', 'Full name')}><TextInput style={s.input} value={f.fullName} onChangeText={set('fullName')} /></Field>
            {!inv.requiresPhone && (
              <Field label={tr('البريد الإلكتروني', 'Email')} hint={inv.requiresEmail ? tr('استخدم البريد الذي وصلتك عليه الدعوة', 'Use the invited email') : undefined}>
                <TextInput style={s.input} value={f.email} onChangeText={set('email')} autoCapitalize="none" keyboardType="email-address" />
              </Field>
            )}
            {!inv.requiresEmail && (
              <Field label={tr('رقم الجوال', 'Phone')}><TextInput style={s.input} value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" placeholder="+9665XXXXXXXX" /></Field>
            )}
            <Field label={tr('كلمة المرور', 'Password')} hint={tr('8 أحرف على الأقل تتضمن حروفًا وأرقامًا', '8+ characters with letters and digits')}>
              <TextInput style={s.input} value={f.password} onChangeText={set('password')} secureTextEntry />
            </Field>
          </>
        ) : (
          <>
            <Field label={tr('البريد أو الجوال', 'Email or phone')}><TextInput style={s.input} value={f.identifier} onChangeText={set('identifier')} autoCapitalize="none" /></Field>
            <Field label={tr('كلمة المرور', 'Password')}><TextInput style={s.input} value={f.password} onChangeText={set('password')} secureTextEntry /></Field>
          </>
        )}
        {err != null && <ErrorView error={err} />}
        <Btn title={tr('قبول الدعوة', 'Accept invite')} busy={busy} onPress={submit} />
      </Card>
    </Screen>
  );
}
