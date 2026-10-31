import {
  LIFECYCLE_BUSY_MESSAGE,
  LIFECYCLE_READY,
  LIFECYCLE_STARTING,
  LIFECYCLE_WORKING,
  createWorkerLifecycle
} from '@group-hub/shared/worker-lifecycle';

const deferred = () => {
  let resolve: (value?: unknown) => void = () => undefined;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('worker lifecycle', () => {
  it('runs the session start once for concurrent callers', async () => {
    const gate = deferred();
    const startSession = jasmine.createSpy().and.callFake(() => gate.promise);
    const lifecycle = createWorkerLifecycle(startSession);
    const callers = [lifecycle.finishStart(), lifecycle.finishStart(), lifecycle.exclusive(async () => 'done')];
    gate.resolve();
    const results = await Promise.all(callers);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(results[2]).toBe('done');
    expect(lifecycle.current()).toBe(LIFECYCLE_READY);
  });

  it('returns to starting when the session start fails, then retries', async () => {
    const startSession = jasmine.createSpy().and.returnValues(Promise.reject(new Error('no')), Promise.resolve());
    const lifecycle = createWorkerLifecycle(startSession);
    await expectAsync(lifecycle.finishStart()).toBeRejected();
    expect(lifecycle.current()).toBe(LIFECYCLE_STARTING);
    await lifecycle.finishStart();
    expect(lifecycle.isReady()).toBeTrue();
  });

  it('refuses a second action while one is working', async () => {
    const lifecycle = createWorkerLifecycle(async () => undefined);
    const gate = deferred();
    const first = lifecycle.exclusive(() => gate.promise);
    await lifecycle.finishStart();
    await Promise.resolve();
    expect(lifecycle.current()).toBe(LIFECYCLE_WORKING);
    await expectAsync(lifecycle.exclusive(async () => undefined)).toBeRejectedWithError(LIFECYCLE_BUSY_MESSAGE);
    gate.resolve();
    await first;
    expect(lifecycle.isReady()).toBeTrue();
  });

  it('lets only one of two simultaneous actions through', async () => {
    const lifecycle = createWorkerLifecycle(async () => undefined);
    lifecycle.resumeReady();
    const results = await Promise.allSettled([
      lifecycle.exclusive(async () => 'first'),
      lifecycle.exclusive(async () => 'second')
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('releases the lock and runs the follow-up when an action fails', async () => {
    const lifecycle = createWorkerLifecycle(async () => undefined);
    const afterRelease = jasmine.createSpy().and.callFake(() => expect(lifecycle.isReady()).toBeTrue());
    await expectAsync(lifecycle.exclusive(() => Promise.reject(new Error('no')), afterRelease)).toBeRejected();
    expect(afterRelease).toHaveBeenCalledTimes(1);
    expect(lifecycle.isReady()).toBeTrue();
  });

  it('skips the follow-up when the action was refused', async () => {
    const lifecycle = createWorkerLifecycle(async () => undefined);
    const gate = deferred();
    const first = lifecycle.exclusive(() => gate.promise);
    await lifecycle.finishStart();
    await Promise.resolve();
    const afterRelease = jasmine.createSpy();
    await expectAsync(lifecycle.exclusive(async () => undefined, afterRelease)).toBeRejected();
    expect(afterRelease).not.toHaveBeenCalled();
    gate.resolve();
    await first;
  });

  it('rejects an impossible transition', () => {
    const lifecycle = createWorkerLifecycle(async () => undefined);
    lifecycle.resumeReady();
    expect(() => lifecycle.resumeReady()).toThrowError(/cannot go from/);
  });
});
