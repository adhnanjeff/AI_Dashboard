import WorkflowView from '../../../components/WorkflowView.tsx';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowView id={id} />;
}
