import { useRef, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api, ApiError } from '../../../lib/session';
import { Btn, C, Card, Screen, T, useLang } from '../../../components/ui';

/**
 * مسح QR:
 *  - mode=student: بطاقة الطالب (معرّف مساعد؛ التسجيل يتطلب تأكيد السائق)
 *  - mode=rear: ملصق مؤخرة الباص أثناء فحص الخلو
 */
export default function Scan() {
  const { id = '', mode = 'student' } = useLocalSearchParams<{ id: string; mode?: 'student' | 'rear' }>();
  const { tr } = useLang();
  const [perm, requestPerm] = useCameraPermissions();
  const [msg, setMsg] = useState<string | null>(null);
  const busy = useRef(false);

  async function onScan(data: string) {
    if (busy.current) return;
    busy.current = true;
    const token = data.trim();
    if (mode === 'rear') {
      router.dismissTo({ pathname: '/driver/end/[id]', params: { id, rearToken: token } });
      return;
    }
    try {
      const r = await api('POST', `/driver/trips/${id}/qr`, { qrToken: token });
      router.dismissTo({ pathname: '/driver/trip/[id]', params: { id, scannedStudent: r.rider.studentId } });
    } catch (e) {
      setMsg(e instanceof ApiError
        ? e.status === 0 ? tr('لا يوجد اتصال للتحقق من البطاقة. استخدم القائمة اليدوية.', 'Offline — use the manual list.') : e.message
        : tr('تعذر قراءة البطاقة', 'Could not read the card'));
      setTimeout(() => { busy.current = false; }, 2000);
    }
  }

  if (!perm) return null;
  if (!perm.granted) {
    return (
      <Screen>
        <Card>
          <T>{tr('نحتاج إذن الكاميرا لمسح البطاقة. يمكنك دائمًا التسجيل يدويًا من القائمة.', 'Camera permission is needed. You can always use the manual list.')}</T>
          <Btn title={tr('السماح بالكاميرا', 'Allow camera')} onPress={requestPerm} />
          <Btn kind="ghost" title={tr('رجوع', 'Back')} onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => onScan(r.data)} />
      <View style={{ padding: 16, gap: 8, backgroundColor: C.white }}>
        <T>{mode === 'rear' ? tr('امسح الملصق المثبت في مؤخرة الباص', 'Scan the sticker at the rear of the bus') : tr('وجّه الكاميرا إلى بطاقة الطالب', 'Point the camera at the student card')}</T>
        {msg && <T style={{ color: C.red }}>{msg}</T>}
        <Btn kind="secondary" title={tr('رجوع', 'Back')} onPress={() => router.back()} />
      </View>
    </View>
  );
}
