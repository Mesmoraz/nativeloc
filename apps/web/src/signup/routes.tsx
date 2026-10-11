import { Navigate, Route } from 'react-router-dom';
import type { MeResponse } from '../contracts';
import { Settings } from './Settings';
import { Signup } from './Signup';
import { VerifyEmail } from './VerifyEmail';
import { Welcome } from './Welcome';

/**
 * Owned by Segment 2 piece 2A (sign-up and onboarding: /signup, /verify-email, /welcome, /settings). App.tsx renders
 * these whether or not someone is signed in (`session` is null when signed out).
 */
export function signupRoutes(session: MeResponse | null): React.ReactNode {
  return (
    <>
      <Route path="/signup" element={session ? <Navigate to="/welcome" /> : <Signup />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      {session && <Route path="/welcome" element={<Welcome />} />}
      {session && <Route path="/settings" element={<Settings />} />}
    </>
  );
}
