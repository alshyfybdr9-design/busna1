import { useLocalSearchParams } from 'expo-router';
import { Screen } from '../components/ui';
import { LoginForm, routeAfterLogin } from '../components/auth';

export default function Login() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  return (
    <Screen>
      <LoginForm tenantCode={code} onDone={routeAfterLogin} />
    </Screen>
  );
}
