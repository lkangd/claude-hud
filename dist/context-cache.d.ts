import type { StdinData } from './types.js';
export type ContextCacheDeps = {
    homeDir: () => string;
};
/**
 * Apply context-window fallback in-place:
 * - For suspicious zero frames, try restoring from cache.
 * - For healthy frames, refresh the cache snapshot.
 */
export declare function applyContextWindowFallback(stdin: StdinData, overrides?: Partial<ContextCacheDeps>): void;
//# sourceMappingURL=context-cache.d.ts.map