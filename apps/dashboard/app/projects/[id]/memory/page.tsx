import ProjectMemory from '../../../../components/ProjectMemory.tsx';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectMemory id={id} />;
}
