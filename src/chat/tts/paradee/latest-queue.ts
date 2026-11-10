/** Serialize non-reentrant synthesis and discard requests superseded before they start. */
export function createLatestQueue<T>(run: (request: T, isCurrent: () => boolean) => Promise<void>) {
  let revision = 0;
  let tail: Promise<void> = Promise.resolve();
  return (request: T): void => {
    const current = ++revision;
    const isCurrent = () => current === revision;
    tail = tail.then(async () => {
      if (isCurrent()) await run(request, isCurrent);
    }).catch(() => undefined);
  };
}
