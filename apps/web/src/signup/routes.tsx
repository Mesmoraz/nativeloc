import type { MeResponse } from '../contracts';

/**
 * Owned by Segment 2 piece 2A (sign-up and onboarding: /signup, /verify-email, /welcome, /settings). The pages this piece adds, as <Route> elements (wrap several in a
 * fragment). App.tsx renders them whether or not someone is signed in (`session` is null when signed out),
 * so guard signed-in pages yourself, e.g. `session && <Route ... />`.
 */
export function signupRoutes(_session: MeResponse | null): React.ReactNode {
  return null;
}
