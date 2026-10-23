import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TopBar } from '../App';
import { api, type Project } from '../api';
import { ReadyToPublish } from '../community/ReadyToPublish';
import { postingTabs } from '../posting/projectTabs';
import { Screenshots } from './Screenshots';
import { Overview, type Manifest } from './Overview';
import { Strings } from './Strings';
import { ImportExport } from './ImportExport';
import { Team } from './Team';
import { Questions } from './Questions';
import { Devices } from './Devices';

// Built-in tabs, plus the posting tabs (Add text, Sharing).
type Tab = string;
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['strings', 'Strings'],
  ['import', 'Import & export'],
  ['screens', 'Screenshots'],
  ['team', 'Team'],
  ['questions', 'Questions'],
  ['devices', 'Devices & API'],
  ...postingTabs.map((t): [Tab, string] => [t.id, t.label]),
];

/** Community-reviewed projects get the poster's "Ready to publish" tab, right after Overview. */
function tabsFor(project: Project): [Tab, string][] {
  if (project.reviewMode !== 'community') return TABS;
  const ready = project.progress.reduce((n, p) => n + p.ready, 0);
  return [TABS[0], ['ready', ready ? `Ready to publish (${ready})` : 'Ready to publish'], ...TABS.slice(1)];
}

export function ProjectAdmin() {
  const { projectId = '' } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'overview');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ project: Project; manifest: Manifest | null }>(`/api/v1/projects/${projectId}`);
      setProject(r.project);
      setManifest(r.manifest);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const pick = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };

  return (
    <>
      <TopBar />
      <main className="page">
        {error && <div className="alert error">{error}</div>}
        {project && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <Link to="/" className="muted small">
                ← Projects
              </Link>
            </div>
            <h1>{project.name}</h1>
            <nav className="tabs">
              {tabsFor(project).map(([id, label]) => (
                <button key={id} className={tab === id ? 'active' : ''} onClick={() => pick(id)}>
                  {label}
                </button>
              ))}
            </nav>
            {tab === 'overview' && <Overview project={project} manifest={manifest} reload={load} />}
            {tab === 'strings' && <Strings project={project} />}
            {tab === 'import' && <ImportExport project={project} reload={load} />}
            {tab === 'screens' && <Screenshots projectId={project.id} />}
            {tab === 'team' && <Team project={project} />}
            {tab === 'questions' && <Questions projectId={project.id} />}
            {tab === 'devices' && <Devices project={project} manifest={manifest} reload={load} />}
            {tab === 'ready' && project.reviewMode === 'community' && <ReadyToPublish project={project} reload={load} />}
            {postingTabs.filter((t) => t.id === tab).map((t) => (
              <div key={t.id}>{t.render({ project, reload: load })}</div>
            ))}
          </>
        )}
      </main>
    </>
  );
}
