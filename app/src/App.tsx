import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { PickerPage } from './pages/PickerPage';
import { SortWallPage } from './pages/SortWallPage';
import { AdminPage } from './pages/AdminPage';
import { AppMenu } from './components/AppMenu';
import { startSyncEngine } from './lib/syncEngine';
import type { UserRole } from './types/database';

// Which roles can see which tab (docs Section 4.0 route/tab table). This is
// UX convenience only — Supabase RLS and the RPC functions independently
// enforce the real authorization boundary even if someone edits the URL by
// hand (docs Section 11.6).
const TAB_ACCESS: Record<string, UserRole[]> = {
  '/picker': ['picker'],
  '/sort-wall': ['warehouse_staff', 'ops_manager', 'admin'],
  '/admin': ['admin'],
};

function defaultRouteFor(role: UserRole): string {
  if (role === 'picker') return '/picker';
  if (role === 'admin') return '/admin';
  return '/sort-wall';
}

function AppShell() {
  const { session, profile, loading } = useAuth();

  useEffect(() => {
    const stop = startSyncEngine();
    return stop;
  }, []);

  if (loading) {
    return <div className="loading-screen">Loading…</div>;
  }

  if (!session || !profile) {
    return <LoginPage />;
  }

  const allowedTabs = Object.entries(TAB_ACCESS)
    .filter(([, roles]) => roles.includes(profile.role))
    .map(([path]) => path);

  return (
    <div className="app-shell">
      {/* No persistent header/title bar by design — the hamburger menu is the
          entire site chrome. Scanner screens render as fullscreen overlays
          that cover this button, so there is nothing to conditionally hide. */}
      <AppMenu tabs={allowedTabs} role={profile.role} />

      <main className="app-main">
        <Routes>
          <Route path="/picker" element={<Guarded role={profile.role} allowed={['picker']}><PickerPage /></Guarded>} />
          <Route
            path="/sort-wall"
            element={
              <Guarded role={profile.role} allowed={['warehouse_staff', 'ops_manager', 'admin']}>
                <SortWallPage />
              </Guarded>
            }
          />
          <Route path="/admin" element={<Guarded role={profile.role} allowed={['admin']}><AdminPage /></Guarded>} />
          <Route path="*" element={<Navigate to={defaultRouteFor(profile.role)} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Guarded({
  role,
  allowed,
  children,
}: {
  role: UserRole;
  allowed: UserRole[];
  children: ReactNode;
}) {
  if (!allowed.includes(role)) {
    return <Navigate to={defaultRouteFor(role)} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </AuthProvider>
  );
}
