import { Navigate, Route, useParams } from 'react-router-dom';
import type { MeResponse } from '../contracts';

/** /p/:projectId/ready opens the project's "Ready to publish" tab (ProjectAdmin renders ReadyToPublish). */
function ReadyRedirect() {
  const { projectId = '' } = useParams();
  return <Navigate to={`/p/${projectId}#ready`} replace />;
}

/**
 * Community review's pages (/p/:projectId/ready), as <Route> elements. App.tsx renders them whether or not someone is signed in (`session` is null when signed out),
 * so guard signed-in pages yourself, e.g. `session && <Route ... />`.
 */
export function communityRoutes(session: MeResponse | null): React.ReactNode {
  return session && <Route path="/p/:projectId/ready" element={<ReadyRedirect />} />;
}
