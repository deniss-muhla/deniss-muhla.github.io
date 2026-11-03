/**
 * The vendor surface the Whistle worker calls, declared here so no vendor package type
 * escapes into the project.
 *
 * The runtime is the pinned `needle.js` served byte-identical from
 * `/models/cactus-needle/wasm/`, loaded with `importScripts`. Only the calls the worker
 * makes are declared: `ccall` for the four C entry points, the allocator around it, the
 * heap accessor for PCM and model bytes, and the string reader for the JSON results.
 *
 * `wasmBinary` is passed to the factory so the runtime instantiates the pinned wasm from
 * the bytes this project fetched instead of resolving a path relative to the worker URL.
 */
declare function importScripts(...urls: string[]): void;

declare function createNeedle(moduleArg?: { wasmBinary?: Uint8Array }): Promise<NeedleModule>;

interface NeedleModule {
  ccall(
    name: string,
    returnType: "number" | "string" | null,
    argTypes: readonly string[],
    args: readonly unknown[],
  ): number | string;
  _malloc(size: number): number;
  _free(pointer: number): void;
  readonly HEAPU8: Uint8Array;
  UTF8ToString(pointer: number): string;
}
