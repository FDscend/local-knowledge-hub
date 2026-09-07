export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTaskExecutor } = await import("./src/lib/task-executor");
    startTaskExecutor();
  }
}
