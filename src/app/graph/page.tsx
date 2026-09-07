import { GraphPanel } from "@/components/GraphPanel";
import { getGraphStatus } from "@/lib/graph";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

type GraphPageProps = {
  searchParams: Promise<{ knowledgeBaseId?: string }>;
};

export default async function GraphPage({ searchParams }: GraphPageProps) {
  const { knowledgeBaseId } = await searchParams;
  // 知识库由全局顶部切换器驱动（URL knowledgeBaseId）；缺失时回落默认收件箱。
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId?.trim() || "default");
  const targetBaseId = knowledgeBase.id;
  const status = await getGraphStatus(targetBaseId);

  return (
    <div className="workspace-page graph-page">
      <header className="workspace-toolbar graph-toolbar">
        <div className="workspace-toolbar-copy">
          <p className="workspace-kicker">KNOWLEDGE GRAPH</p>
          <h2>知识图谱</h2>
          <p className="muted-text">
            按知识库查看文档与标签的关系网络。绿色实线为文档内 Markdown 链接（显式），琥珀虚线为共享标签、灰色点线为同一导入来源（规则），蓝色虚线为切片向量语义近邻（模型建议，非事实关系）。每条边都可查看证据来源与置信度。
          </p>
        </div>
      </header>

      <GraphPanel key={targetBaseId} knowledgeBaseId={targetBaseId} initialStatus={status} />
    </div>
  );
}
