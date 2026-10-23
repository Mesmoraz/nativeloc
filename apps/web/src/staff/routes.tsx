import { Navigate, Route } from 'react-router-dom';
import type { MeResponse } from '../contracts';
import { StaffConsole } from './StaffConsole';

/**
 * The staff console's page (/staff), as a <Route> element. App.tsx renders them whether or not someone is signed in (`session` is null when signed out),
 * so guard signed-in pages yourself, e.g. `session && <Route ... />`.
 */
export function staffRoutes(session: MeResponse | null): React.ReactNode {
  if (!session) return null;
  return <Route path="/staff" element={session.user.isStaff ? <StaffConsole /> : <Navigate to="/" />} />;
}
