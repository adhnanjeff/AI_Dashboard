import ProjectWorktrees from '../../../../components/ProjectWorktrees.tsx';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectWorktrees id={id} />;
}
