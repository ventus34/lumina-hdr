/**
 * Owns one latest-wins asynchronous operation at a time.
 * Starting a new operation aborts the previous one; stale operations cannot
 * clear or replace the current operation when their finally blocks run.
 */
export function createLatestOperationManager() {
  let active = null;
  let nextId = 0;

  return {
    begin() {
      active?.controller.abort();

      const controller = new AbortController();
      const request = {
        id: ++nextId,
        controller,
        signal: controller.signal,
        isCurrent: () => active === request && !controller.signal.aborted
      };
      active = request;
      return request;
    },

    finish(request) {
      if (active !== request) return false;
      active = null;
      return true;
    },

    get current() {
      return active;
    }
  };
}
