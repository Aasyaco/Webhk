const retryTasks = new Map();

/**
 * Schedule retry for failed backport.
 * Prevent duplicate retries.
 */
export function scheduleRetry(key, fn, delay = 60000) {
  if (retryTasks.has(key)) return;

  const timer = setTimeout(async () => {
    try {
      await fn();
    } catch (e) {
      console.error("Retry failed:", e.message);
    }
    retryTasks.delete(key);
  }, delay);

  retryTasks.set(key, timer);
}
