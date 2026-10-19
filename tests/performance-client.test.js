import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProcessingClient,
  ProcessingQueueFullError,
  copyTypedArrayForTransfer
} from '../src/services/processing-client.js';

class FakeWorker {
  listeners = new Map();
  messages = [];
  terminated = false;

  addEventListener(type, listener) {
    const entries = this.listeners.get(type) || [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  postMessage(message, transfer = []) {
    if (this.terminated) throw new Error('worker terminated');
    this.messages.push({ message, transfer });
  }

  reply(index, message) {
    for (const listener of this.listeners.get('message') || []) listener({ data: { id: this.messages[index].message.id, ...message } });
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  terminate() {
    this.terminated = true;
  }
}

function makeClient(options = {}) {
  const workers = [];
  const client = new ProcessingClient({
    maxPendingJobs: 4,
    maxWorkers: 1,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...options
  });
  return { client, workers };
}

test('processing client transfers only the caller supplied buffers', async () => {
  const { client, workers } = makeClient();
  const input = new Uint8Array([1, 2, 3]);
  const promise = client.run('test-copy', { data: input }, { transfer: [input.buffer] });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers[0].messages.length, 1);
  assert.deepEqual(workers[0].messages[0].transfer, [input.buffer]);
  workers[0].reply(0, { ok: true, result: { answer: 42 } });
  assert.deepEqual(await promise, { answer: 42 });
  assert.deepEqual(client.stats, { queued: 0, active: 0, pending: 0, inFlightBytes: 0, workers: 1, disposed: false });
  client.dispose();
});

test('queue limits reject excess work and queued aborts release their reservation', async () => {
  const { client, workers } = makeClient({ maxPendingJobs: 2 });
  const first = client.run('hold', {});
  await new Promise((resolve) => setImmediate(resolve));
  const abortController = new AbortController();
  const queued = client.run('queued', {}, { signal: abortController.signal });
  const overflow = client.run('overflow', {});
  await assert.rejects(overflow, ProcessingQueueFullError);

  abortController.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(client.stats.queued, 0);
  assert.equal(client.stats.pending, 1);

  workers[0].reply(0, { ok: true, result: 'done' });
  assert.equal(await first, 'done');
  client.dispose();
});

test('cancelling a running task terminates its worker and the pool recovers', async () => {
  const { client, workers } = makeClient();
  const abortController = new AbortController();
  const cancelled = client.run('slow', {}, { signal: abortController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abortController.abort('cancelled by caller');
  await assert.rejects(cancelled, { name: 'AbortError', message: 'cancelled by caller' });
  assert.equal(workers[0].terminated, true);

  const next = client.run('next', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 2);
  workers[1].reply(0, { ok: true, result: 'recovered' });
  assert.equal(await next, 'recovered');
  client.dispose();
});

test('late errors from a cancelled worker cannot terminate its replacement', async () => {
  for (const eventType of ['error', 'messageerror']) {
    const { client, workers } = makeClient();
    const abortController = new AbortController();
    const cancelled = client.run('slow', {}, { signal: abortController.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abortController.abort('replace worker');
    await assert.rejects(cancelled, { name: 'AbortError', message: 'replace worker' });

    const replacement = client.run('next', {});
    const replacementOutcome = replacement.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workers.length, 2);
    assert.equal(client.stats.active, 1);

    workers[0].emit(eventType, { message: 'late event from terminated worker' });

    assert.equal(workers[1].terminated, false, `${eventType} from the old worker must not terminate its replacement`);
    assert.equal(client.stats.active, 1, `${eventType} from the old worker must not finish the replacement job`);
    workers[1].reply(0, { ok: true, result: 'replacement completed' });
    assert.deepEqual(await replacementOutcome, { value: 'replacement completed' });
    client.dispose();
  }
});

test('aborting a slow native fallback rejects immediately and releases the slot on settlement', async () => {
  const client = new ProcessingClient({ maxPendingJobs: 4, maxWorkers: 1, workerFactory: () => { throw new Error('no worker'); } });
  const abortController = new AbortController();
  let finishFallback;
  let fallbackSignal;
  const first = client.run('native', { input: new Uint8Array([1]) }, {
    signal: abortController.signal,
    fallback: ({ signal }) => {
      fallbackSignal = signal;
      return new Promise((resolve) => { finishFallback = resolve; });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishFallback, 'function');

  abortController.abort('native fallback cancelled');
  const rejectedFirst = assert.rejects(first, { name: 'AbortError', message: 'native fallback cancelled' });
  await rejectedFirst;
  assert.equal(fallbackSignal.aborted, true);
  assert.equal(client.stats.pending, 1);

  let finishSecond;
  const second = client.run('next', {}, {
    fallback: () => new Promise((resolve) => { finishSecond = resolve; })
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishSecond, 'undefined');
  assert.equal(client.stats.queued, 1);

  finishFallback('stale result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishSecond, 'function');
  assert.equal(client.stats.pending, 1);
  finishSecond('next result');
  assert.equal(await second, 'next result');
  assert.equal(client.stats.pending, 0);
  client.dispose();
});

test('disposing releases a never-settling aborted fallback reservation exactly once', async () => {
  const client = new ProcessingClient({ maxPendingJobs: 2, maxWorkers: 1, workerFactory: () => { throw new Error('no worker'); } });
  const abortController = new AbortController();
  const pending = client.run('native', { input: new Uint8Array(8) }, {
    signal: abortController.signal,
    fallback: () => new Promise(() => {})
  });
  await new Promise((resolve) => setImmediate(resolve));
  const reason = new Error('stop waiting');
  abortController.abort(reason);
  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.message === reason.message && error.cause === reason);
  assert.equal(client.stats.pending, 1);
  assert.equal(client.stats.inFlightBytes, 8);

  client.dispose();
  assert.equal(client.stats.pending, 0);
  assert.equal(client.stats.inFlightBytes, 0);
});

test('dispose rejects active and queued tasks and terminates workers', async () => {
  const { client, workers } = makeClient();
  const active = client.run('active', {});
  await new Promise((resolve) => setImmediate(resolve));
  const queued = client.run('queued', {});
  client.dispose('app unloaded');
  await assert.rejects(active, { code: 'DISPOSED', message: 'app unloaded' });
  await assert.rejects(queued, { code: 'DISPOSED', message: 'app unloaded' });
  assert.equal(workers[0].terminated, true);
  assert.equal(client.stats.pending, 0);
});

test('payload limits and explicit fallback protect unsupported environments', async () => {
  const { client } = makeClient({ maxJobBytes: 2 });
  await assert.rejects(client.run('too-big', { bytes: new Uint8Array(3) }), { code: 'PAYLOAD_TOO_LARGE' });
  client.dispose();

  const fallbackClient = new ProcessingClient({ workerFactory: () => { throw new Error('workers disabled'); } });
  assert.equal(await fallbackClient.run('native', {}, { fallback: async () => 'main-thread' }), 'main-thread');
  fallbackClient.dispose();
});

test('prepared payloads are not allocated when worker startup selects fallback', async () => {
  const client = new ProcessingClient({ workerFactory: () => { throw new Error('worker blocked by policy'); } });
  let prepared = false;
  const result = await client.runPrepared('large-export', 32, () => {
    prepared = true;
    return { payload: { data: new Uint8Array(32) }, transfer: [] };
  }, {
    fallback: async () => 'small local fallback'
  });
  assert.equal(result, 'small local fallback');
  assert.equal(prepared, false);
  client.dispose();
});

test('prepared payloads are built and transferred after worker startup', async () => {
  const { client, workers } = makeClient();
  let prepared = false;
  const input = new Uint8Array([5, 6, 7]);
  const result = client.runPrepared('prepared', input.byteLength, () => {
    prepared = true;
    return { payload: { input }, transfer: [input.buffer] };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, true);
  assert.deepEqual(workers[0].messages[0].transfer, [input.buffer]);
  workers[0].reply(0, { ok: true, result: 'done' });
  assert.equal(await result, 'done');
  client.dispose();
});

test('compressed image decodes reserve their output budget before reading input', async () => {
  const reserve = 64 * 1024 * 1024;
  const { client, workers } = makeClient({
    maxJobBytes: reserve,
    maxInFlightBytes: reserve,
    decodeReserveBytes: reserve
  });
  const first = client.decodeImage(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/test' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers[0].messages.length, 1);
  assert.equal(client.stats.inFlightBytes, reserve);

  await assert.rejects(
    client.decodeImage(new Blob([new Uint8Array([4, 5, 6])], { type: 'image/test' })),
    ProcessingQueueFullError
  );

  workers[0].reply(0, { ok: true, result: { width: 1, height: 1, data: new Float32Array(4) } });
  const decoded = await first;
  assert.equal(decoded.width, 1);
  assert.equal(client.stats.inFlightBytes, 0);
  client.dispose();
});

test('decode tasks never run concurrently even when a lower reserve is configured', async () => {
  const reserve = 32 * 1024 * 1024;
  const { client, workers } = makeClient({
    maxWorkers: 2,
    maxJobBytes: reserve,
    maxInFlightBytes: reserve * 2,
    decodeReserveBytes: reserve
  });
  const first = client.decodeImage(new Blob([new Uint8Array([1])], { type: 'image/test' }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = client.decodeImage(new Blob([new Uint8Array([2])], { type: 'image/test' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 1);
  assert.equal(client.stats.queued, 1);

  workers[0].reply(0, { ok: true, result: { width: 1, height: 1, data: new Float32Array(4) } });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers[0].messages.length, 2);
  workers[0].reply(1, { ok: true, result: { width: 1, height: 1, data: new Float32Array(4) } });
  await second;
  client.dispose();
});

test('stalled worker tasks time out, terminate, and release queue capacity', async () => {
  const { client, workers } = makeClient({ jobTimeoutMs: 10 });
  const pending = client.run('stalled', {});
  await assert.rejects(pending, { code: 'WORKER_TIMEOUT' });
  assert.equal(workers[0].terminated, true);
  assert.equal(client.stats.pending, 0);
  client.dispose();
});

test('transfer copies do not detach or alias the active image', () => {
  const original = new Float32Array([0.25, 0.5, 1]);
  const copy = copyTypedArrayForTransfer(original);
  assert.notEqual(copy.buffer, original.buffer);
  copy[0] = 0;
  assert.equal(original[0], 0.25);
});
