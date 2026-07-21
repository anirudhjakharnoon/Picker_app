import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { LoginPage } from './pages/LoginPage';
import { PickerPage } from './pages/PickerPage';
import { SortWallPage } from './pages/SortWallPage';
import { AdminPage } from './pages/AdminPage';
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
  const { session, profile, loading, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

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

  const allowedTabs = Object.entries(TAB_ACCESS).filter(([, roles]) => roles.includes(profile.role));

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="app-nav-brand">Picker &amp; Sort Wall</div>
        <div className="app-nav-tabs">
          {allowedTabs.map(([path]) => (
            <button
              key={path}
              className={location.pathname.startsWith(path) ? 'active' : ''}
              onClick={() => navigate(path)}
            >
              {path === '/picker' ? 'Picker' : path === '/sort-wall' ? 'Sort Wall' : 'Admin'}
            </button>
          ))}
        </div>
        <button className="app-nav-signout" onClick={() => void signOut()}>
          Sign out
        </button>
      </nav>

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
