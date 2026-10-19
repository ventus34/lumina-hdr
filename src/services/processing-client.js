const DEFAULTS = Object.freeze({
  maxPendingJobs: 8,
  maxWorkers: 2,
  jobTimeoutMs: 300_000,
  maxJobBytes: 512 * 1024 * 1024,
  maxInFlightBytes: 768 * 1024 * 1024
});

export class ProcessingError extends Error {
  constructor(message, { code = 'PROCESSING_FAILED', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProcessingError';
    this.code = code;
  }
}

export class ProcessingQueueFullError extends ProcessingError {
  constructor() {
    super('The image processing queue is full. Wait for a current task to finish.', {
      code: 'QUEUE_FULL'
    });
    this.name = 'ProcessingQueueFullError';
  }
}

export class ProcessingUnavailableError extends ProcessingError {
  constructor(message = 'Background image processing is unavailable in this browser.') {
    super(message, { code: 'WORKER_UNAVAILABLE' });
    this.name = 'ProcessingUnavailableError';
  }
}

function abortError(reason) {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === 'string'
      ? reason
      : 'The operation was aborted.';
  const error = new Error(message, reason instanceof Error ? { cause: reason } : undefined);
  error.name = 'AbortError';
  return error;
}

function isAbortSignal(signal) {
  return signal && typeof signal.addEventListener === 'function' && 'aborted' in signal;
}

function estimateBytes(value, seen = new Set(), depth = 0) {
  if (value == null || depth > 8) return 0;
  if (typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);

  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return value.byteLength;

  let total = 0;
  if (Array.isArray(value)) {
    for (const entry of value) total += estimateBytes(entry, seen, depth + 1);
    return total;
  }
  for (const entry of Object.values(value)) total += estimateBytes(entry, seen, depth + 1);
  return total;
}

function defaultWorkerFactory() {
  if (typeof Worker === 'undefined') {
    throw new ProcessingUnavailableError();
  }
  // Vite bundles this worker into the application as an inline module so the
  // single-file build still works without fetching a separate worker script.
  return import('../workers/processing-worker.js?worker&inline').then(({ default: WorkerConstructor }) => new WorkerConstructor());
}

function settleResolve(job, value) {
  if (job.settled) return;
  job.settled = true;
  job.resolve(value);
}

function settleReject(job, error) {
  if (job.settled) return;
  job.settled = true;
  job.reject(error);
}

/**
 * Bounded module-worker pool for CPU-heavy image codecs.
 *
 * `run` transfers only buffers explicitly listed in `transfer`; callers that
 * pass image data should transfer a copy so the active preview remains owned
 * by the UI. A cancelled running task terminates its worker, which is the only
 * reliable way to stop synchronous JavaScript/WASM codec work.
 */
export class ProcessingClient {
  constructor({
    maxPendingJobs = DEFAULTS.maxPendingJobs,
    maxWorkers = DEFAULTS.maxWorkers,
    jobTimeoutMs = DEFAULTS.jobTimeoutMs,
    maxJobBytes = DEFAULTS.maxJobBytes,
    decodeReserveBytes = maxJobBytes,
    nativeFallbackMaxBytes = 128 * 1024 * 1024,
    maxInFlightBytes = DEFAULTS.maxInFlightBytes,
    workerFactory = defaultWorkerFactory
  } = {}) {
    this.maxPendingJobs = Math.max(1, Math.floor(maxPendingJobs));
    this.maxWorkers = Math.max(1, Math.floor(maxWorkers));
    this.jobTimeoutMs = Math.max(1, jobTimeoutMs);
    this.maxJobBytes = Math.max(0, maxJobBytes);
    this.decodeReserveBytes = Math.min(this.maxJobBytes, Math.max(0, decodeReserveBytes));
    this.nativeFallbackMaxBytes = Math.max(1, nativeFallbackMaxBytes);
    this.maxInFlightBytes = Math.max(this.maxJobBytes, maxInFlightBytes);
    this.workerFactory = workerFactory;
    this.queue = [];
    this.slots = [];
    this.pendingCount = 0;
    this.inFlightBytes = 0;
    this.nextId = 1;
    this.disposed = false;
  }

  get stats() {
    return Object.freeze({
      queued: this.queue.length,
      active: this.slots.filter((slot) => slot.job && slot.job.state === 'running').length,
      pending: this.pendingCount,
      inFlightBytes: this.inFlightBytes,
      workers: this.slots.filter((slot) => slot.worker).length,
      disposed: this.disposed
    });
  }

  run(task, payload, { signal, transfer = [], fallback } = {}) {
    const bytes = estimateBytes(payload);
    return this.#enqueue(task, bytes, async () => ({ payload, transfer }), { signal, fallback });
  }

  /**
   * Run work whose payload must be prepared only after worker startup succeeds.
   * `estimatedBytes` reserves queue and transfer capacity before `prepare`
   * allocates copies such as a transferable full-frame image buffer.
   */
  runPrepared(task, estimatedBytes, prepare, { signal, fallback } = {}) {
    if (typeof prepare !== 'function') return Promise.reject(new TypeError('prepare must be a function.'));
    return this.#enqueue(task, estimatedBytes, prepare, { signal, fallback });
  }

  /** Decode a File/Blob on a worker while preserving its ownership on the main thread. */
  decodeImage(file, { signal } = {}) {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size)) {
      return Promise.reject(new TypeError('decodeImage expects a File or Blob.'));
    }
    const fallback = () => import('./decode-image.js').then(({ decodeImage }) => decodeImage(file, {
      signal,
      maxBytes: this.nativeFallbackMaxBytes,
      holdWorkOnAbort: true
    }));
    const reservationBytes = Math.max(file.size, this.decodeReserveBytes);
    return this.#enqueue('decode-image', reservationBytes, async () => {
      const buffer = await file.arrayBuffer();
      if (signal?.aborted) throw abortError(signal.reason);
      return {
        payload: { buffer, name: file.name || 'image', type: file.type || '' },
        transfer: [buffer]
      };
    }, { signal, fallback, reservationFloor: this.decodeReserveBytes });
  }

  #enqueue(task, bytes, prepare, { signal, fallback, reservationFloor = 0 } = {}) {
    if (this.disposed) return Promise.reject(new ProcessingError('Processing client has been disposed.', { code: 'DISPOSED' }));
    if (typeof task !== 'string' || !task) return Promise.reject(new TypeError('A processing task name is required.'));
    if (signal !== undefined && !isAbortSignal(signal)) return Promise.reject(new TypeError('signal must be an AbortSignal.'));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxJobBytes) {
      return Promise.reject(new ProcessingError(`Task payload exceeds the ${this.maxJobBytes}-byte processing limit.`, { code: 'PAYLOAD_TOO_LARGE' }));
    }
    if (this.pendingCount >= this.maxPendingJobs || this.inFlightBytes + bytes > this.maxInFlightBytes) {
      return Promise.reject(new ProcessingQueueFullError());
    }

    return new Promise((resolve, reject) => {
      const job = {
        id: this.nextId++,
        task,
        bytes,
        reservationFloor,
        prepare,
        fallback,
        signal,
        resolve,
        reject,
        state: 'queued',
        settled: false,
        released: false,
        slot: null,
        abortHandler: null,
        timeoutId: null
      };
      this.pendingCount++;
      this.inFlightBytes += bytes;
      if (signal) {
        job.abortHandler = () => this.#abort(job);
        signal.addEventListener('abort', job.abortHandler, { once: true });
      }
      this.queue.push(job);
      this.#pump();
    });
  }

  #pump() {
    if (this.disposed) return;
    while (this.queue.length) {
      let slot = this.slots.find((candidate) => !candidate.job && !candidate.starting);
      if (!slot && this.slots.length < this.maxWorkers) {
        slot = { worker: null, job: null, starting: false };
        this.slots.push(slot);
      }
      if (!slot) return;
      const decodeInProgress = this.slots.some((candidate) => candidate.job?.task === 'decode-image');
      const queueIndex = this.queue.findIndex((candidate) => candidate.task !== 'decode-image' || !decodeInProgress);
      if (queueIndex === -1) return;
      const [job] = this.queue.splice(queueIndex, 1);
      if (job.settled) continue;
      slot.job = job;
      job.slot = slot;
      job.state = 'starting';
      this.#start(slot, job);
    }
  }

  async #start(slot, job) {
    slot.starting = true;
    try {
      let worker = slot.worker;
      if (!worker) {
        worker = await this.workerFactory();
        if (job.settled || this.disposed || slot.job !== job) {
          worker?.terminate?.();
          slot.starting = false;
          if (!this.disposed) this.#pump();
          return;
        }
        slot.worker = worker;
        this.#attachWorker(slot, worker);
      }

      const { payload, transfer = [] } = await job.prepare();
      if (job.settled || this.disposed || slot.job !== job) return;
      const actualBytes = estimateBytes(payload);
      if (actualBytes > this.maxJobBytes) throw new ProcessingError('Prepared task payload exceeds the processing limit.', { code: 'PAYLOAD_TOO_LARGE' });
      // Decoding can expand a tiny compressed file into hundreds of MiB. Keep
      // its conservative reservation while the worker/native decoder runs,
      // even after transferring the much smaller compressed input buffer.
      const accountedBytes = Math.max(actualBytes, job.reservationFloor);
      const delta = accountedBytes - job.bytes;
      if (this.inFlightBytes + delta > this.maxInFlightBytes) throw new ProcessingQueueFullError();
      this.inFlightBytes += delta;
      job.bytes = accountedBytes;
      this.#validateTransferList(transfer);
      job.state = 'running';
      slot.starting = false;
      worker.postMessage({ id: job.id, task: job.task, payload }, transfer);
      job.timeoutId = setTimeout(() => {
        if (job.settled || job.state !== 'running') return;
        const timeoutError = new ProcessingError(`Processing task exceeded ${this.jobTimeoutMs} ms.`, { code: 'WORKER_TIMEOUT' });
        this.#terminateSlot(slot);
        this.#finish(slot, job, false, timeoutError);
      }, this.jobTimeoutMs);
    } catch (error) {
      slot.starting = false;
      if (job.settled || this.disposed || slot.job !== job) return;
      if (!slot.worker && typeof job.fallback === 'function') {
        this.#runFallback(slot, job, error);
      } else {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.#finish(slot, job, false, wrapped);
      }
    }
  }

  #validateTransferList(transfer) {
    if (!Array.isArray(transfer)) throw new TypeError('transfer must be an array of transferable objects.');
    for (const item of transfer) {
      const isBuffer = item instanceof ArrayBuffer ||
        (typeof MessagePort !== 'undefined' && item instanceof MessagePort) ||
        (typeof ImageBitmap !== 'undefined' && item instanceof ImageBitmap) ||
        (typeof OffscreenCanvas !== 'undefined' && item instanceof OffscreenCanvas);
      if (!isBuffer) throw new TypeError('Only transferable buffers, ports, bitmaps, and canvases may be transferred.');
      if (item instanceof ArrayBuffer && item.byteLength === 0) {
        // Empty buffers are valid and are retained; the branch documents the
        // detached-buffer check without rejecting zero-length codec inputs.
        continue;
      }
    }
  }

  #attachWorker(slot, worker) {
    worker.addEventListener('message', (event) => {
      const message = event.data;
      const job = slot.job;
      if (!job || message?.id !== job.id) return;
      if (message.ok) {
        const outputBytes = estimateBytes(message.result);
        if (outputBytes > this.maxJobBytes) {
          this.#finish(slot, job, false, new ProcessingError('Worker result exceeds the processing limit.', { code: 'PAYLOAD_TOO_LARGE' }));
          return;
        }
        const accountedOutputBytes = Math.max(outputBytes, job.reservationFloor);
        const adjustedBytes = this.inFlightBytes - job.bytes + accountedOutputBytes;
        if (adjustedBytes > this.maxInFlightBytes) {
          this.#finish(slot, job, false, new ProcessingQueueFullError());
          return;
        }
        this.inFlightBytes = adjustedBytes;
        job.bytes = accountedOutputBytes;
        this.#finish(slot, job, true, message.result);
      } else {
        const details = message.error || {};
        const error = new ProcessingError(details.message || 'Image processing failed.', {
          code: details.code || 'PROCESSING_FAILED'
        });
        error.name = details.name || 'ProcessingError';
        if (details.code === 'REQUIRES_MAIN_THREAD' && typeof job.fallback === 'function') {
          this.#runFallback(slot, job, error);
        } else {
          this.#finish(slot, job, false, error);
        }
      }
    });
    worker.addEventListener('error', (event) => {
      // A cancelled job may already have replaced this worker in the slot by
      // the time its final error event is delivered. Never let that stale
      // event terminate the replacement worker or reject its job.
      if (slot.worker !== worker) return;
      const job = slot.job;
      if (!job) return;
      const error = new ProcessingError(event.message || 'The processing worker stopped unexpectedly.', {
        code: 'WORKER_CRASHED'
      });
      this.#terminateSlot(slot);
      this.#finish(slot, job, false, error);
    });
    worker.addEventListener('messageerror', () => {
      if (slot.worker !== worker) return;
      const job = slot.job;
      if (!job) return;
      this.#terminateSlot(slot);
      this.#finish(slot, job, false, new ProcessingError('The worker returned data that could not be read.', { code: 'WORKER_MESSAGE_ERROR' }));
    });
  }

  #runFallback(slot, job, workerError) {
    job.state = 'fallback';
    Promise.resolve().then(() => job.fallback({ signal: job.signal, cause: workerError })).then(
      (result) => {
        if (job.signal?.aborted) this.#finish(slot, job, false, abortError(job.signal.reason));
        else this.#finish(slot, job, true, result);
      },
      (error) => this.#finish(slot, job, false, error instanceof Error ? error : new Error(String(error)))
    );
  }

  #abort(job) {
    if (job.settled) return;
    if (job.state === 'queued') {
      const index = this.queue.indexOf(job);
      if (index !== -1) this.queue.splice(index, 1);
      this.#release(job);
      settleReject(job, abortError(job.signal?.reason));
      this.#pump();
      return;
    }
    if (job.state === 'running') {
      const slot = job.slot;
      if (slot) this.#terminateSlot(slot);
      this.#finish(slot, job, false, abortError(job.signal?.reason));
      return;
    }
    // A starting task may be waiting for worker creation or File.arrayBuffer.
    // Settle it now; #start will discard the worker/payload when it resumes.
    if (job.state === 'starting') {
      this.#finish(job.slot, job, false, abortError(job.signal?.reason));
    }
    if (job.state === 'fallback') {
      // Some browser decoders ignore AbortSignal. Reject the caller now, but
      // keep the slot and reservation until the fallback actually settles so
      // a replacement job cannot overcommit memory or run alongside it.
      settleReject(job, abortError(job.signal?.reason));
    }
  }

  #finish(slot, job, succeeded, value) {
    if (!job || job.released) return;
    if (slot?.job === job) {
      slot.job = null;
      slot.starting = false;
    }
    job.slot = null;
    this.#release(job);
    if (succeeded) settleResolve(job, value);
    else settleReject(job, value);
    this.#pump();
  }

  #release(job) {
    if (job.released) return;
    job.released = true;
    if (job.abortHandler) job.signal.removeEventListener('abort', job.abortHandler);
    if (job.timeoutId !== null) clearTimeout(job.timeoutId);
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    this.inFlightBytes = Math.max(0, this.inFlightBytes - job.bytes);
    job.bytes = 0;
  }

  #terminateSlot(slot) {
    if (!slot) return;
    slot.worker?.terminate?.();
    slot.worker = null;
    slot.starting = false;
  }

  dispose(reason = 'Processing client has been disposed.') {
    if (this.disposed) return;
    this.disposed = true;
    const error = new ProcessingError(reason, { code: 'DISPOSED' });
    for (const job of [...this.queue]) {
      this.queue.splice(this.queue.indexOf(job), 1);
      this.#release(job);
      settleReject(job, error);
    }
    for (const slot of this.slots) {
      const job = slot.job;
      this.#terminateSlot(slot);
      if (job) {
        this.#release(job);
        settleReject(job, error);
        slot.job = null;
      }
    }
    this.slots.length = 0;
  }
}

export function createProcessingClient(options) {
  return new ProcessingClient(options);
}

export const processingClient = createProcessingClient();

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) processingClient.dispose('The application page is closing.');
  });
}

export function disposeProcessingClient(reason) {
  processingClient.dispose(reason);
}

/** Return an owned, independent copy suitable for transfer to a worker. */
export function copyTypedArrayForTransfer(view) {
  if (!ArrayBuffer.isView(view) || view instanceof DataView) {
    throw new TypeError('Expected a typed array.');
  }
  const copy = new view.constructor(view.length);
  copy.set(view);
  return copy;
}

export function estimateProcessingPayloadBytes(payload) {
  return estimateBytes(payload);
}
