'use client';
import Link from 'next/link';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { Project } from '../lib/types.ts';
import MemoryPanel from './MemoryPanel.tsx';
import { ErrorBanner } from './small.tsx';

export default function ProjectMemory({ id }: { id: string }) {
  const projects = usePolling(() => api<Project[]>('/projects'), 30000, 'projects');
  const project = projects.data?.find((p) => p.id === id);
  return (
    <>
      <div className="page-head">
        <p style={{ margin: 0 }}><Link href="/">← Overview</Link></p>
        <h1>Project memory{project ? `: ${project.name}` : ''}</h1>
        {project && <p className="muted small" style={{ margin: 0 }}>{project.repoPath}</p>}
      </div>
      <ErrorBanner error={projects.data ? null : projects.error} what="project" />
      {projects.data && !project && <div className="card empty"><p><strong>Project not found.</strong></p></div>}
      {project && <MemoryPanel scope="project" id={id} heading="Shared notes" blurb="Shared by every session in this project. Relevant notes are added to each worker's prompt as reference data, never as instructions." />}
    </>
  );
}
