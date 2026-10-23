import { Link } from 'react-router-dom';
import { useSession } from '../App';
import { ConfirmEmail } from './shared';
import './signup.css';

/** Top of Home: "Confirm your email", or "Finish setting up" for someone with no org and no languages. */
export function HomeNotice(): React.ReactNode {
  const { session } = useSession();
  if (!session) return null;
  const { user, orgs } = session;
  if (!user.emailVerified) return <ConfirmEmail email={user.email} compact />;
  if (!orgs.length && !user.locales.length) {
    return (
      <div className="card row">
        <div style={{ flex: 1, minWidth: 200 }}>
          <b>Finish setting up</b>
          <div className="small muted">Pick your languages to volunteer, or set up your organization to get translation.</div>
        </div>
        <Link className="btn primary" to="/welcome">
          Get started
        </Link>
      </div>
    );
  }
  return null;
}
