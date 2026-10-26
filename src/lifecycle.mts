import { HarnessError, requireCondition } from './contracts.mjs';
import type { HarnessInstance } from './types.mjs';

export async function deadline<T>(work: Promise<T>, ms: number, code: string, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (()=>void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      if(controller){abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted){abort();return;}}
      timer = setTimeout(() => {
        const error = new HarnessError(code, code); controller?.abort(error); reject(error);
      }, ms);
    })]);
  } finally { clearTimeout(timer);if(abort)controller?.signal.removeEventListener('abort',abort); }
}

/** A timed-out acquisition remains owned until the actual factory settles and is disposed. */
export class Acquisition {
  readonly controller = new AbortController();
  readonly pending: Promise<HarnessInstance>;
  instance: HarnessInstance | undefined;
  cleanup: Promise<void> | undefined;
  abandoned = false;
  settled = false;
  constructor(factory: (signal: AbortSignal) => Promise<HarnessInstance>) {
    this.pending = Promise.resolve().then(() => factory(this.controller.signal));
    this.pending.then(instance => {
      this.instance = instance; this.settled = true;
      if (this.abandoned) void this.dispose().catch(() => {});
    }, () => { this.settled = true; });
  }
  abandon(): void {
    this.abandoned = true; this.controller.abort(new HarnessError('START_CANCELLED', 'Acquisition abandoned'));
    if (this.instance) void this.dispose().catch(() => {});
  }
  dispose(): Promise<void> {
    if (!this.cleanup) this.cleanup = this.pending.then(instance => instance.stop());
    return this.cleanup;
  }
}

export async function terminateOwned(instance: HarnessInstance, ownership: string, ms: number): Promise<void> {
  requireCondition(ownership === 'owned' && typeof instance.terminate === 'function', 'TERMINATION_DENIED', 'Only an owned instance with a termination contract can be forced');
  await deadline(Promise.resolve().then(() => instance.terminate!()), ms, 'TERMINATE_TIMEOUT');
}
