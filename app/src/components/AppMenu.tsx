import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { MenuIcon } from './icons';
import type { UserRole } from '../types/database';

const TAB_LABELS: Record<string, string> = {
  '/picker': 'Picker',
  '/sort-wall': 'Sort Wall',
  '/admin': 'Admin',
  '/manpower': 'Manpower',
};

/**
 * The site's ONLY navigation chrome: a single hamburger button that opens a
 * small dropdown with role-appropriate tabs and sign-out. There is no
 * persistent header/title bar — every page (Picker, Sort Wall, Admin) owns
 * its own content starting right at the top of the viewport, and scanner
 * screens cover this button entirely via their own fullscreen overlay so it
 * never has to be hidden with extra logic.
 */
export function AppMenu({ tabs, role }: { tabs: string[]; role: UserRole }) {
  const [open, setOpen] = useState(false);
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickAway);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <div className="app-menu" ref={containerRef}>
      <button
        type="button"
        className="icon-button app-menu-trigger"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MenuIcon />
      </button>

      {open && (
        <div className="app-menu-panel" role="menu">
          <div className="app-menu-brand">
            <span className="brand-wordmark">
              Dubai Mall
              <span className="brand-wordmark-sub">Delivery ops</span>
            </span>
          </div>
          <div className="app-menu-user">
            <strong>{profile?.full_name ?? profile?.email}</strong>
            <span className="app-menu-role">{role.replace(/_/g, ' ')}</span>
          </div>

          {tabs.length > 1 && (
            <div className="app-menu-tabs">
              {tabs.map((path) => (
                <button
                  key={path}
                  type="button"
                  role="menuitem"
                  className={location.pathname.startsWith(path) ? 'active' : ''}
                  onClick={() => {
                    setOpen(false);
                    navigate(path);
                  }}
                >
                  {TAB_LABELS[path] ?? path}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            role="menuitem"
            className="app-menu-signout"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
