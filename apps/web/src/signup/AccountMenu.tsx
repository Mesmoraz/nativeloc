import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../App';
import { api } from '../api';
import { ORG_TYPE_LABEL } from './shared';
import './signup.css';

/** The top bar's account menu: switch the current org, settings, staff console, sign out. */
export function AccountMenu(): React.ReactNode {
  const { session, refresh, logout } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const ref = useRef<HTMLDetailsElement>(null);

  // Close on navigation and on clicks outside.
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [location.pathname]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  if (!session) return null;
  const { user, org, orgs } = session;

  async function switchTo(orgId: number) {
    await api('/api/v1/me/org', { method: 'PUT', body: { orgId } });
    await refresh();
    if (ref.current) ref.current.open = false;
    navigate('/');
  }

  return (
    <details className="su-menu" ref={ref}>
      <summary className="su-avatar" aria-label="Account menu" title={user.name}>
        {user.name.trim().charAt(0).toUpperCase() || '?'}
      </summary>
      <div className="su-menu-panel" role="menu">
        <div className="su-menu-head">
          <b>{user.name}</b>
          <div className="small muted">{user.email}</div>
        </div>
        {orgs.length > 0 && (
          <>
            <hr />
            <div className="small muted su-menu-head">Working in</div>
            {orgs.map((o) => (
              <button key={o.id} role="menuitemradio" aria-checked={o.id === org?.id} aria-current={o.id === org?.id} onClick={() => o.id !== org?.id && void switchTo(o.id)}>
                <span className="su-org-name">
                  <span>
                    {o.id === org?.id ? '✓ ' : ''}
                    {o.name}
                  </span>
                  <span className="small muted">
                    {ORG_TYPE_LABEL[o.type]} · {o.role}
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
        <hr />
        <Link to="/settings" role="menuitem">
          Account settings
        </Link>
        <Link to="/welcome" role="menuitem">
          {orgs.length ? 'Volunteer or set up another organization' : 'Volunteer or get translation'}
        </Link>
        {user.isStaff && (
          <Link to="/staff" role="menuitem">
            Staff console
          </Link>
        )}
        <hr />
        <button role="menuitem" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </details>
  );
}
