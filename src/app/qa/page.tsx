import { AskPanel } from "@/components/AskPanel";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type QaPageProps = { searchParams: Promise<{ knowledgeBaseId?: string }> };

export default async function QaPage({ searchParams }: QaPageProps) {
  const { knowledgeBaseId } = await searchParams;
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);

  return (
    <div className="workspace-page qa-page">
      <AskPanel knowledgeBaseId={knowledgeBase.id} />
    </div>
  );
}
