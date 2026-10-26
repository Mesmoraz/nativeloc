import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { shortDate } from '../volunteer/badges';
import type { Certificate, RevokedCertificate } from '../volunteer/types';
import './certificate.css';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const periodOf = (c: Pick<Certificate, 'periodFrom' | 'periodTo'>) =>
  c.periodFrom ? `${shortDate(c.periodFrom)} to ${shortDate(c.periodTo)}` : `all volunteering up to ${shortDate(c.periodTo)}`;

/**
 * /certificate/:code: a volunteer-hour certificate, laid out to print (A4 or Letter) and to be checked. The page is
 * the verification: it shows what NativeLoc issued under this code, or that it was withdrawn.
 */
export function CertificatePage() {
  const { code = '' } = useParams();
  const [cert, setCert] = useState<Certificate | RevokedCertificate | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Certificate | RevokedCertificate>(`/api/v1/certificates/${encodeURIComponent(code)}`).then(setCert, (e) =>
      setError(e instanceof ApiError && e.status === 404 ? 'There is no certificate with this code. Check the link, or ask the volunteer for a new one.' : 'Could not load the certificate. Try again.'),
    );
  }, [code]);

  useEffect(() => {
    if (cert) document.title = `Volunteer certificate · ${cert.name}`;
  }, [cert]);

  if (error) return <main className="cert-page"><div className="cert-sheet cert-problem">{error}</div></main>;
  if (!cert) return null;
  if ('revoked' in cert)
    return (
      <main className="cert-page">
        <div className="cert-sheet cert-problem">
          <h1>Certificate withdrawn</h1>
          <p>
            {cert.name} withdrew this certificate (for {periodOf(cert)}, issued {shortDate(cert.issuedAt)}) on {shortDate(cert.revokedAt)}. It no
            longer counts as a record of volunteer hours.
          </p>
        </div>
      </main>
    );

  const url = window.location.href;
  return (
    <main className="cert-page">
      <div className="cert-tools">
        <button className="btn primary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>
      <article className="cert-sheet">
        <header className="cert-head">
          <span className="brand-mark" aria-hidden>
            文A
          </span>
          <span>NativeLoc</span>
        </header>
        <p className="cert-kicker">Certificate of volunteer service</p>
        <h1 className="cert-name">{cert.name}</h1>
        <p className="cert-lede">translated and reviewed text for community organizations, so people can read it in their own language.</p>
        <p className="cert-hours">
          <span className="cert-hours-num">{cert.hours.toLocaleString()}</span> volunteer {cert.hours === 1 ? 'hour' : 'hours'}
        </p>
        <p className="cert-period">For {periodOf(cert)}</p>
        {cert.orgs.length > 0 && (
          <div className="cert-orgs">
            <h2>Organizations helped</h2>
            <p>{cert.orgs.join(' · ')}</p>
          </div>
        )}
        <div className="cert-method">
          <h2>How the hours were counted</h2>
          <p>
            Estimated from approved work only: {plural(cert.translations, 'translation', 'translations')} at {cert.rates.translate} minutes each and{' '}
            {plural(cert.reviews, 'review', 'reviews')} at {cert.rates.review} minute{cert.rates.review === 1 ? '' : 's'} each (rates of {cert.rates.version}),
            rounded down to the half hour. Work that reviewers didn't approve isn't counted.
          </p>
        </div>
        <footer className="cert-foot">
          <div>
            Issued by NativeLoc on {shortDate(cert.issuedAt)}
            <br />
            Check this certificate: <span className="cert-url">{url}</span>
          </div>
        </footer>
      </article>
    </main>
  );
}
