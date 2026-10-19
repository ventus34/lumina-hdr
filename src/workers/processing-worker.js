import { getTransferables, runProcessingTask } from './processing-tasks.js';

self.addEventListener('message', async ({ data }) => {
  const { id, task, payload } = data || {};
  if (!Number.isInteger(id)) return;
  try {
    const result = await runProcessingTask(task, payload || {});
    self.postMessage({ id, ok: true, result }, getTransferables(result));
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: {
        name: error?.name || 'Error',
        code: error?.code || 'PROCESSING_FAILED',
        message: error?.message || String(error)
      }
    });
  }
});
