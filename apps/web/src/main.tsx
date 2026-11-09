import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { I18nProvider } from './i18n';
import { SessionProvider } from './session';
import { ApiError } from './api';
import { EntryPage, TenantLinkPage, InvitePage, ContextPicker, MobileOnlyPage } from './pages/auth';
import { TenantLayout, PlatformLayout } from './pages/Layout';
import { Dashboard } from './pages/tenant/Dashboard';
import { Students, StudentDetail } from './pages/tenant/Students';
import { RoutesPage, RouteDetail, Buses } from './pages/tenant/Routes';
import { Trips, TripDetail } from './pages/tenant/Trips';
import { Alerts } from './pages/tenant/Alerts';
import { Team } from './pages/tenant/Team';
import { Absences, Settings, Audit } from './pages/tenant/Misc';
import { PlatformTenants, PlatformHealth, PlatformPlans, PlatformStaff, PlatformAccessLog } from './pages/platform/Platform';
import { Loading } from './components/ui';
import { TicketsPage, TicketDetailPage } from './pages/support/Tickets';
import { KnowledgePage } from './pages/support/Knowledge';
import { AssistantPage } from './pages/support/Assistant';
import { useSession, currentMembership } from './session';

function TenantKnowledge() {
  const { session } = useSession();
  return <KnowledgePage scope="tenant" canEdit={currentMembership(session)?.role === 'tenant_admin'} />;
}

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
});

function Gate({ children }: { children: React.ReactNode }) {
  const { ready } = useSession();
  return ready ? <>{children}</> : <div className="center-page"><Loading /></div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <BrowserRouter>
            <Gate>
              <Routes>
                <Route path="/" element={<EntryPage />} />
                <Route path="/t/:code" element={<TenantLinkPage />} />
                <Route path="/invite/:token" element={<InvitePage />} />
                <Route path="/select" element={<ContextPicker />} />
                <Route path="/mobile-only" element={<MobileOnlyPage />} />
                <Route path="/app" element={<TenantLayout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="students" element={<Students />} />
                  <Route path="students/:id" element={<StudentDetail />} />
                  <Route path="routes" element={<RoutesPage />} />
                  <Route path="routes/:id" element={<RouteDetail />} />
                  <Route path="buses" element={<Buses />} />
                  <Route path="trips" element={<Trips />} />
                  <Route path="trips/:id" element={<TripDetail />} />
                  <Route path="alerts" element={<Alerts />} />
                  <Route path="absences" element={<Absences />} />
                  <Route path="team" element={<Team />} />
                  <Route path="settings" element={<Settings />} />
                  <Route path="audit" element={<Audit />} />
                  <Route path="support" element={<TicketsPage base="/app/support" />} />
                  <Route path="support/:id" element={<TicketDetailPage base="/app/support" />} />
                  <Route path="knowledge" element={<TenantKnowledge />} />
                  <Route path="assistant" element={<AssistantPage />} />
                </Route>
                <Route path="/platform" element={<PlatformLayout />}>
                  <Route index element={<PlatformTenants />} />
                  <Route path="health" element={<PlatformHealth />} />
                  <Route path="plans" element={<PlatformPlans />} />
                  <Route path="staff" element={<PlatformStaff />} />
                  <Route path="access" element={<PlatformAccessLog />} />
                  <Route path="support" element={<TicketsPage base="/platform/support" platform />} />
                  <Route path="support/:id" element={<TicketDetailPage base="/platform/support" />} />
                  <Route path="knowledge" element={<KnowledgePage scope="platform" canEdit />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Gate>
          </BrowserRouter>
        </SessionProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
