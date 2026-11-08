// يجب استيراد مهمة التتبع أولًا ليتم تعريفها عند إقلاع التطبيق في الخلفية
import '../lib/tracking';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../lib/SessionContext';
import { C, LangProvider } from '../components/ui';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <LangProvider>
        <SessionProvider>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: C.white },
              headerTintColor: C.greenDark,
              headerTitleStyle: { fontWeight: '700' },
              contentStyle: { backgroundColor: C.bg },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="welcome" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ title: 'تسجيل الدخول' }} />
            <Stack.Screen name="invite/[token]" options={{ title: 'دعوة' }} />
            <Stack.Screen name="t/[code]" options={{ title: 'باصنا' }} />
            <Stack.Screen name="select" options={{ title: 'اختر الجهة' }} />
            <Stack.Screen name="driver/index" options={{ title: 'رحلاتي اليوم' }} />
            <Stack.Screen name="driver/trip/[id]" options={{ title: 'الرحلة' }} />
            <Stack.Screen name="driver/scan/[id]" options={{ title: 'مسح بطاقة' }} />
            <Stack.Screen name="driver/end/[id]" options={{ title: 'إنهاء الرحلة وفحص الباص', headerBackVisible: false }} />
            <Stack.Screen name="parent/index" options={{ title: 'أبنائي' }} />
            <Stack.Screen name="parent/child/[id]" options={{ title: 'متابعة الرحلة' }} />
            <Stack.Screen name="parent/absence" options={{ title: 'طلب غياب' }} />
            <Stack.Screen name="notifications" options={{ title: 'الإشعارات' }} />
            <Stack.Screen name="support" options={{ title: 'الدعم والتواصل' }} />
          </Stack>
        </SessionProvider>
      </LangProvider>
    </SafeAreaProvider>
  );
}
