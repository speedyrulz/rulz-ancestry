import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BuildStopped, buildPack, type BuildInput } from './packbuild';

/**
 * The worker thread that builds a pack (see `packbuild.ts`). It is started
 * with the build's input and a shared flag, and tells the main thread how many
 * rows are written, and at the end whether the pack is made. It does nothing
 * when it is imported anywhere else, as in a test.
 */
interface Start {
  rulzPackBuild: true;
  input: BuildInput;
  flag: Int32Array;
}

const start = workerData as Partial<Start> | null;

if (!isMainThread && parentPort !== null && start?.rulzPackBuild === true) {
  const port = parentPort;
  const { input, flag } = start as Start;
  buildPack(input, {
    stop: () => Atomics.load(flag, 0) !== 0,
    progress: (rows) => port.postMessage({ type: 'progress', rows }),
  }).then(
    (meta) => port.postMessage({ type: 'done', meta }),
    (error: unknown) =>
      port.postMessage({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
        stopped: error instanceof BuildStopped,
      }),
  );
}
