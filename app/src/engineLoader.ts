import { createEngine, type Engine, type EngineFactory } from '@opentunes/engine';

export class EngineUnavailableError extends Error {}

/**
 * A fresh engine with its own empty in-memory iPod folder.
 *
 * The engine is built separately (`npm run engine:build`, needs Docker) and copied to
 * /engine by the dev and build scripts, see scripts/sync-engine.mjs. It is loaded at run
 * time, not bundled, because it is a 2.7 MB WebAssembly program with its own loader.
 */
export async function newEngine(): Promise<Engine> {
  const url = new URL('engine/engine.js', document.baseURI).href;
  let factory: EngineFactory;
  try {
    const loaded = (await import(/* @vite-ignore */ url)) as { default: EngineFactory };
    factory = loaded.default;
  } catch (error) {
    throw new EngineUnavailableError(
      'The engine is not available. Run `npm run engine:build` (it needs Docker), then restart `npm run dev`.',
      { cause: error },
    );
  }
  return createEngine(factory);
}
