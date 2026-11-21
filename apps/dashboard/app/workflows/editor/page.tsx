import { Suspense } from 'react';
import WorkflowEditor from '../../../components/WorkflowEditor.tsx';

export default function Page() {
  return <Suspense fallback={<p className="muted">Loading the editor…</p>}><WorkflowEditor /></Suspense>;
}
