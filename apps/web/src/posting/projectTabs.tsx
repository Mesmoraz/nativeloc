import type { ProjectTab } from '../contracts';
import { AddContent } from './AddContent';
import { Sharing } from './Sharing';

/** Project admin tabs for posting content: add text and choose who sees the project. */
export const postingTabs: ProjectTab[] = [
  { id: 'add', label: 'Add text', render: ({ project, reload }) => <AddContent project={project} onAdded={reload} /> },
  { id: 'sharing', label: 'Sharing', render: ({ project, reload }) => <Sharing project={project} reload={reload} /> },
];
