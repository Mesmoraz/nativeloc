import { Route } from 'react-router-dom';
import { CertificatePage } from './CertificatePage';

/** Public pages: a volunteer-hour certificate opens for anyone with its link, signed in or not. */
export function certificateRoutes(): React.ReactNode {
  return <Route path="/certificate/:code" element={<CertificatePage />} />;
}
