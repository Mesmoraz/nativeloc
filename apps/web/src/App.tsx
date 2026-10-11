import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { ProjectAdmin } from './admin/ProjectAdmin';
import { api } from './api';
import { communityRoutes } from './community/routes';
import type { MeResponse } from './contracts';
import { Workspace } from './localizer/Workspace';
import { Home } from './pages/Home';
import { Grading } from './pages/Grading';
import { Invite } from './pages/Invite';
import { Join } from './pages/Join';
import { Login } from './pages/Login';
import { Placement } from './pages/Placement';
import { postingRoutes } from './posting/routes';
import { AccountMenu } from './signup/AccountMenu';
import { signupRoutes } from './signup/routes';
import { staffRoutes } from './staff/routes';
import { isMock } from './volunteer/client';
import { VolunteerApp } from './volunteer/VolunteerApp';

/** GET /api/v1/me. `org` is null for someone who belongs to no org yet. */
type Session = MeResponse;

const SessionContext = createContext<{ session: Session | null; refresh: () => Promise<void>; logout: () => Promise<void> }>({
  session: null,
  refresh: async () => {},
  logout: async () => {},
});
export const useSession = () => useContext(SessionContext);

export function TopBar({ children }: { children?: React.ReactNode }) {
  const { session, logout } = useSession();
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <span className="brand-mark">文A</span>
        <span className="hide-sm">NativeLoc</span>
      </Link>
      {children ?? <span className="spacer" />}
      {session && (
        <div className="row small" style={{ flexWrap: 'nowrap' }}>
          <span className="muted hide-sm">
            {session.user.name}
            {session.org ? ` · ${session.org.name}` : ''}
          </span>
          {session.user.isStaff && (
            <Link to="/staff" className="hide-sm">
              Staff
            </Link>
          )}
          <button className="ghost hide-sm" onClick={logout}>
            Sign out
          </button>
          {/* Shown at every width: the org switcher, and sign out on phones. */}
          <AccountMenu />
        </div>
      )}
    </header>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSession(await api<Session>('/api/v1/me'));
    } catch {
      setSession(null);
    }
  }, []);
  const logout = useCallback(async () => {
    await api('/api/v1/auth/logout', { method: 'POST' });
    setSession(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (session === undefined) return null;

  return (
    <SessionContext.Provider value={{ session, refresh, logout }}>
      <Routes>
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/join/:code" element={<Join />} />
        {/* The dev mock (?mock=1) runs the card flow without signing in. */}
        {isMock && <Route path="/v" element={<VolunteerApp />} />}
        {/* Segment 2 pieces add their pages here (each file is owned by one piece). */}
        {signupRoutes(session)}
        {staffRoutes(session)}
        {communityRoutes(session)}
        {postingRoutes(session)}
        {!session ? (
          <Route path="*" element={<Login />} />
        ) : (
          <>
            <Route path="/" element={<Home />} />
            <Route path="/v" element={<VolunteerApp />} />
            <Route path="/p/:projectId/:locale/:mode" element={<Workspace />} />
            <Route path="/placement/:locale" element={<Placement />} />
            <Route path="/grading" element={<Grading />} />
            <Route path="/p/:projectId" element={session.user.role === 'admin' ? <ProjectAdmin /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </>
        )}
      </Routes>
    </SessionContext.Provider>
  );
}
