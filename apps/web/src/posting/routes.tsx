import { Route } from 'react-router-dom';
import type { MeResponse } from '../contracts';
import { NewProject, NewProjectContent } from './NewProject';

/**
 * Posting's pages (/new, /new/:id), as <Route> elements. App.tsx renders them whether or not someone is signed in (`session` is null when signed out),
 * so guard signed-in pages yourself, e.g. `session && <Route ... />`.
 */
export function postingRoutes(session: MeResponse | null): React.ReactNode {
  if (!session) return null;
  return (
    <>
      <Route path="/new" element={<NewProject />} />
      <Route path="/new/:projectId" element={<NewProjectContent />} />
    </>
  );
}
