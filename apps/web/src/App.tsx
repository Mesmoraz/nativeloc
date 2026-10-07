import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { ProjectAdmin } from './admin/ProjectAdmin';
import { api, type User } from './api';
import { Workspace } from './localizer/Workspace';
import { Home } from './pages/Home';
import { Grading } from './pages/Grading';
import { Invite } from './pages/Invite';
import { Join } from './pages/Join';
import { Login } from './pages/Login';
import { Placement } from './pages/Placement';

interface Session {
  user: User;
  org: { id: number; name: string };
}

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
        <div className="row hide-sm small">
          <span className="muted">
            {session.user.name} · {session.org.name}
          </span>
          <button className="ghost" onClick={logout}>
            Sign out
          </button>
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
        {!session ? (
          <Route path="*" element={<Login />} />
        ) : (
          <>
            <Route path="/" element={<Home />} />
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
