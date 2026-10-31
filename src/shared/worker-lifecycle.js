export const LIFECYCLE_STARTING = 'starting';
export const LIFECYCLE_FINISHING_START = 'finishingStart';
export const LIFECYCLE_READY = 'ready';
export const LIFECYCLE_WORKING = 'working';

export const LIFECYCLE_BUSY_MESSAGE = 'Group Hub is still working. Try again when it finishes.';

const TRANSITIONS = {
  [LIFECYCLE_STARTING]: [LIFECYCLE_FINISHING_START, LIFECYCLE_READY],
  [LIFECYCLE_FINISHING_START]: [LIFECYCLE_READY, LIFECYCLE_STARTING],
  [LIFECYCLE_READY]: [LIFECYCLE_WORKING],
  [LIFECYCLE_WORKING]: [LIFECYCLE_READY]
};

export function createWorkerLifecycle(startSession) {
  let current = LIFECYCLE_STARTING;
  let starting = null;

  function moveTo(next) {
    if (!TRANSITIONS[current].includes(next)) {
      throw new Error(`Group Hub cannot go from ${current} to ${next}`);
    }
    current = next;
  }

  async function runStart() {
    moveTo(LIFECYCLE_FINISHING_START);
    try {
      await startSession();
      moveTo(LIFECYCLE_READY);
    } catch (error) {
      moveTo(LIFECYCLE_STARTING);
      throw error;
    } finally {
      starting = null;
    }
  }

  function finishStart() {
    if (current === LIFECYCLE_READY || current === LIFECYCLE_WORKING) {
      return Promise.resolve();
    }
    starting ??= runStart();
    return starting;
  }

  async function exclusive(action, afterRelease) {
    await finishStart();
    if (current !== LIFECYCLE_READY) {
      throw new Error(LIFECYCLE_BUSY_MESSAGE);
    }
    moveTo(LIFECYCLE_WORKING);
    try {
      return await action();
    } finally {
      moveTo(LIFECYCLE_READY);
      await afterRelease?.();
    }
  }

  return {
    current: () => current,
    resumeReady: () => moveTo(LIFECYCLE_READY),
    finishStart,
    exclusive,
    isReady: () => current === LIFECYCLE_READY,
    isWorking: () => current === LIFECYCLE_WORKING
  };
}
