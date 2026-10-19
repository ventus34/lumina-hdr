# Image processing workers

CPU-heavy EXR, JXR, RGBE, and PNG codec tasks run through the bounded module-worker client in `src/services/processing-client.js`. The client permits at most eight pending operations, two worker slots, 512 MiB per task, and 768 MiB of reserved in-flight payloads by default. Each decode reserves the full per-task budget before reading the compressed file, so a small file cannot make room for another large decode based only on its compressed size. Set `decodeReserveBytes` to tune that conservative reservation. Each worker task also has a five-minute timeout. Queue overflow and oversized input or output payloads fail before the result is accepted.

`processingClient.decodeImage(file, { signal })` transfers a fresh buffer read from the `File`/`Blob` to the worker, so the caller retains the source file. If the browser cannot create a worker, it falls back to the decoder service on the main thread with a 128 MiB decoded-pixel limit by default (`nativeFallbackMaxBytes`); worker decoding keeps the 512 MiB per-task limit. `processingClient.run(task, payload, { signal, transfer, fallback })` is the generic entry point. Use `runPrepared(task, estimatedBytes, prepare, options)` when payload construction allocates a large copy: the client reserves its known size and creates the payload only after worker startup succeeds. For image exports, copy the canonical pixel array with `copyTypedArrayForTransfer(image.data)` and transfer that copy; transferring the live preview buffer would detach it.

Queued operations are removed when their signal aborts. A running worker is terminated to stop synchronous JavaScript or WASM work, then recreated for subsequent tasks. Native image decoders that require the DOM return a recoverable `REQUIRES_MAIN_THREAD` error and use the caller's fallback. Native fallback work receives the signal but cannot be forcibly interrupted if the browser codec ignores it. Call `processingClient.dispose()` when tearing down the app to reject pending work and terminate all worker slots.

`process-and-encode` runs linear-light grading and PNG or RGBE encoding in one worker task. This avoids sending an intermediate full-frame buffer back to the main thread. The transfer budget accounts for queued inputs and returned outputs; decode reservations conservatively prevent simultaneous full-budget decodes, but the accounting does not model every transient codec allocation or images retained by the application after a task resolves. Decoder dimension checks independently cap canonical RGBA output.

The repository includes a Node benchmark over real JXR examples:

```sh
node scripts/benchmark-processing.mjs
node scripts/benchmark-processing.mjs docs/examples/Forza_Horizon_6_native_hdr_scene1.jxr
```

It measures JXR decode and RGBE encode throughput for the supplied fixtures. Node results do not represent browser worker startup, browser memory behavior, native AVIF decoding, or HDR display output. No 8K browser performance claim is made by this script.
