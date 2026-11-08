import { useState } from 'react';
import { Image, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { login, selectMembership, type SessionPayload } from '../lib/session';
import { Btn, Card, ErrorView, Field, T, s, useLang } from './ui';

export function LoginForm({ tenantCode, onDone }: { tenantCode?: string; onDone: (s: SessionPayload) => void }) {
  const { tr } = useLang();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      let sess = await login(id.trim(), pw);
      // رابط/رمز جهة: اختيار العضوية المطابقة تلقائيًا (الخادم يتحقق منها)
      if (tenantCode) {
        const ms = sess.contexts.memberships.filter((m) => m.tenantCode.toUpperCase() === tenantCode.toUpperCase());
        if (ms.length === 1) sess = (await selectMembership(ms[0].membershipId)) ?? sess;
      }
      onDone(sess);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Field label={tr('البريد الإلكتروني أو رقم الجوال', 'Email or phone')}>
        <TextInput style={s.input} value={id} onChangeText={setId} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" />
      </Field>
      <Field label={tr('كلمة المرور', 'Password')}>
        <TextInput style={s.input} value={pw} onChangeText={setPw} secureTextEntry textContentType="password" />
      </Field>
      {err != null && <ErrorView error={err} />}
      <Btn title={tr('تسجيل الدخول', 'Sign in')} busy={busy} disabled={!id || !pw} onPress={submit} />
    </Card>
  );
}

export function TenantHeader({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    <View style={[s.row, { paddingVertical: 8 }]}>
      {logoUrl && <Image source={{ uri: logoUrl }} style={{ width: 48, height: 48, borderRadius: 10 }} />}
      <T bold size={20}>{name}</T>
    </View>
  );
}

export function routeAfterLogin(sess: SessionPayload) {
  router.replace(sess.context.kind === 'membership' ? '/' : '/select');
}

