import type { ProjectTab } from '../contracts';
import { AddContent } from './AddContent';
import { Sharing } from './Sharing';

/** Owned by Segment 2 piece 2D (posting content): extra project admin tabs. */
export const postingTabs: ProjectTab[] = [
  { id: 'add', label: 'Add text', render: ({ project, reload }) => <AddContent project={project} onAdded={reload} /> },
  { id: 'sharing', label: 'Sharing', render: ({ project, reload }) => <Sharing project={project} reload={reload} /> },
];
