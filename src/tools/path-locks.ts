// Tiny async mutexes keyed by absolute file path. They serialize read/write/edit
// sequences so concurrent subagents cannot authorize stale writes over each other.
const locks = new Map<string, Promise<void>>();

async function acquire(abs: string): Promise<() => void> {
  const previous = locks.get(abs) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current);
  locks.set(abs, next);
  await previous;
  return () => {
    release();
    if (locks.get(abs) === next) locks.delete(abs);
  };
}

export async function withPathLocks<T>(absPaths: string[], fn: () => Promise<T>): Promise<T> {
  const unique = [...new Set(absPaths)].sort();
  const releases: (() => void)[] = [];
  try {
    for (const abs of unique) releases.push(await acquire(abs));
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export const withPathLock = <T>(abs: string, fn: () => Promise<T>): Promise<T> => withPathLocks([abs], fn);
