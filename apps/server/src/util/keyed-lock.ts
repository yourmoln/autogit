/**
 * Runs async work one call at a time per key.
 *
 * AutoGit keeps a single shared clone per repository while a repository may run
 * several tasks at once (`maxConcurrentPerRepo`). Everything that writes into
 * that clone — `git clone`, `git fetch --prune` — has to be serialised per
 * repository: two tasks fetching it at the same moment push the same
 * `refs/remotes/origin/*` refs, and git fails the loser with
 * `cannot lock ref … is at X but expected Y`. Work under other keys (other
 * repositories) keeps running in parallel.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Queues `task` behind every earlier call for `key`, then returns its result. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // The stored tail never rejects: one failed run must not poison the queue
    // for the next one, and the entry is dropped once the last run finished.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
