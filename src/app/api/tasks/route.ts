import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteTasks } from "@/lib/tasks";

const deleteTasksSchema = z.object({
  knowledgeBaseId: z.string().trim().min(1),
  taskIds: z.array(z.string().trim().min(1)).min(1),
});

export async function DELETE(request: Request) {
  try {
    const input = deleteTasksSchema.parse(await request.json());
    const result = await deleteTasks(input.knowledgeBaseId, input.taskIds);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "任务记录删除失败。" },
      { status: 400 },
    );
  }
}
