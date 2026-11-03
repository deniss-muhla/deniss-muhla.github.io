import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function mountPageMotion(nativeTimeline: boolean) {
  const listeners = new Map<string, () => void>();
  const frames = new Map<number, () => void>();
  const properties = new Map<string, string>();
  let nextFrame = 0;
  let effect: (() => (() => void)) | undefined;
  let resizeObserved: (() => void) | undefined;
  let disconnected = false;
  const root = {
    querySelectorAll: () => [],
    toggleAttribute: () => undefined,
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
  };
  const document = { documentElement: { scrollHeight: 1100 } };
  const window = {
    innerHeight: 100,
    scrollY: 0,
    requestAnimationFrame: (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    addEventListener: (name: string, callback: () => void) => {
      assert.equal(listeners.has(name), false, "only one listener owns each event");
      listeners.set(name, callback);
    },
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const modules: Record<string, unknown> = {
    react: {
      lazy: () => () => null,
      Suspense: () => null,
      useCallback: (callback: unknown) => callback,
      useRef: () => ({ current: root }),
      useState: (initial: unknown) => [initial, () => undefined],
      useEffect: (callback: typeof effect) => { effect ??= callback; },
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "react-markdown": { default: () => null },
    "remark-gfm": { default: () => null },
    "../data/content": { profile: {} },
    "../offline/OfflineBadge": { OfflineBadge: () => null },
    "../../resources/photo/hero-photo.jpg": { default: "" },
    "../../resources/photo/cv-photo.jpg": { default: "" },
    "../../resources/cv/source/cv.md?raw": { default: "" },
    "./cv-navigation": {},
    "./Page.module.css": { default: {} },
  };
  const source = process.env.PAGE_MOTION_SOURCE_OVERRIDE
    ?? fileURLToPath(new URL("../src/page/Page.tsx", import.meta.url));
  const compiled = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(compiled.outputText, {
    module, exports: module.exports, window, document,
    CSS: { supports: () => nativeTimeline },
    ResizeObserver: class {
      constructor(callback: () => void) { resizeObserved = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    require: (name: string) => {
      assert.ok(Object.hasOwn(modules, name), "only the page's named seams are loaded");
      return modules[name];
    },
  });
  (module.exports.Page as () => unknown)();
  assert.ok(effect);
  const cleanup = effect();
  return {
    window, document, listeners, properties, frames, cleanup,
    resize: () => resizeObserved?.(),
    disconnected: () => disconnected,
    renderFrame: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
  };
}

test("Page unsupported timeline clock tracks scroll continuously, reverses and remeasures in its existing frame", () => {
  const page = mountPageMotion(false);
  assert.equal(page.properties.get("--page-progress"), "0");
  page.window.scrollY = 3;
  page.listeners.get("scroll")?.();
  page.window.scrollY = 120;
  page.listeners.get("scroll")?.();
  assert.equal(page.frames.size, 1, "batched scroll updates use the latest position in one frame");
  page.renderFrame();
  assert.equal(page.properties.get("--page-progress"), "0.12", "an intermediate theme position replaces the old two-pixel jump");
  page.document.documentElement.scrollHeight = 2100;
  page.resize();
  page.renderFrame();
  assert.equal(page.properties.get("--page-progress"), "0.06", "layout changes update the progress denominator");
  page.window.scrollY = 0;
  page.listeners.get("scroll")?.();
  page.renderFrame();
  assert.equal(page.properties.get("--page-progress"), "0", "return scroll restores the dark endpoint");
  page.window.scrollY = 2200;
  page.listeners.get("resize")?.();
  page.renderFrame();
  assert.equal(page.properties.get("--page-progress"), "1", "overscroll is clamped");
  page.listeners.get("load")?.();
  page.cleanup();
  assert.equal(page.frames.size, 0);
  assert.equal(page.listeners.size, 0);
  assert.equal(page.disconnected(), true);
});

test("Page native timeline keeps CSS in charge instead of writing a second progress clock", () => {
  const page = mountPageMotion(true);
  page.window.scrollY = 120;
  page.listeners.get("scroll")?.();
  page.renderFrame();
  assert.equal(page.properties.size, 0);
  page.cleanup();
});
