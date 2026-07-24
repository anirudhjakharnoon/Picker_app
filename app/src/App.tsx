import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { PickerPage } from './pages/PickerPage';
import { SortWallPage } from './pages/SortWallPage';
import { AdminPage } from './pages/AdminPage';
import { TestingPage } from './pages/TestingPage';
import { ManpowerPage } from './pages/ManpowerPage';
import { AppMenu } from './components/AppMenu';
import type { UserRole } from './types/database';

// Which roles can see which tab (docs Section 4.0 route/tab table). This is
// UX convenience only — Supabase RLS and the RPC functions independently
// enforce the real authorization boundary even if someone edits the URL by
// hand (docs Section 11.6).
const TAB_ACCESS: Record<string, UserRole[]> = {
  '/picker': ['picker'],
  '/sort-wall': ['warehouse_staff', 'ops_manager', 'admin'],
  '/admin': ['admin'],
  '/manpower': ['admin'],
  '/testing': ['admin'],
};

function defaultRouteFor(role: UserRole): string {
  if (role === 'picker') return '/picker';
  if (role === 'admin') return '/admin';
  return '/sort-wall';
}

function AppShell() {
  const { session, profile, loading, signOut } = useAuth();

  if (loading) {
    return <div className="loading-screen">Loading…</div>;
  }

  if (!session || !profile) {
    return <LoginPage />;
  }

  // A suspended or offboarded picker cannot use the app: no queue, no scanning,
  // no receiving orders. The server also forces them offline and refuses to put
  // them back online, but this blocks the UI immediately on their device.
  if (profile.role === 'picker' && profile.status !== 'active') {
    return (
      <div className="auth-screen">
        <div className="auth-card blocked-card">
          <h1>Account {profile.status === 'offboarded' ? 'closed' : 'suspended'}</h1>
          <p className="auth-subtitle">
            {profile.status === 'offboarded'
              ? 'This picker account has been closed. Please contact your administrator.'
              : 'Your account has been suspended and is not receiving orders. Please contact your administrator to be reactivated.'}
          </p>
          <button type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  const allowedTabs = Object.entries(TAB_ACCESS)
    .filter(([, roles]) => roles.includes(profile.role))
    .map(([path]) => path);

  // Pickers work almost entirely inside full-screen scan flows on a phone, so
  // the floating hamburger is just clutter that overlaps their content — they
  // have a single tab anyway. They sign out from their own top bar instead.
  // Every other role keeps the hamburger as its navigation chrome.
  const isPicker = profile.role === 'picker';

  return (
    <div className="app-shell">
      {!isPicker && <AppMenu tabs={allowedTabs} role={profile.role} />}

      <main className={`app-main${isPicker ? ' app-main--flush' : ''}`}>
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
          <Route path="/testing" element={<Guarded role={profile.role} allowed={['admin']}><TestingPage /></Guarded>} />
          <Route path="/manpower" element={<Guarded role={profile.role} allowed={['admin']}><ManpowerPage /></Guarded>} />
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
