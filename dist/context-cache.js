import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHudPluginDir } from './claude-config-dir.js';
const CACHE_FILENAME = 'context-cache.json';
const SUSPICIOUS_INPUT_THRESHOLD = 200_000;
const defaultDeps = {
    homeDir: () => os.homedir(),
};
/**
 * Resolve the on-disk cache file used for context window fallback.
 */
function getCachePath(homeDir) {
    return path.join(getHudPluginDir(homeDir), CACHE_FILENAME);
}
/**
 * Read the last known good context snapshot from disk.
 * Returns null when the cache is missing, malformed, or invalid.
 */
function readCache(homeDir) {
    try {
        const cachePath = getCachePath(homeDir);
        if (!fs.existsSync(cachePath))
            return null;
        const content = fs.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(content);
        if (typeof parsed.used_percentage !== 'number' || !Number.isFinite(parsed.used_percentage)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Persist a known-good context snapshot for future fallback use.
 * Any write failure is intentionally ignored to keep rendering non-blocking.
 */
function writeCache(homeDir, contextWindow) {
    try {
        const cachePath = getCachePath(homeDir);
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const payload = {
            used_percentage: contextWindow.used_percentage ?? 0,
            remaining_percentage: contextWindow.remaining_percentage ?? null,
            current_usage: contextWindow.current_usage ?? null,
            context_window_size: contextWindow.context_window_size ?? null,
            saved_at: Date.now(),
        };
        fs.writeFileSync(cachePath, JSON.stringify(payload), 'utf8');
    }
    catch {
        // Ignore cache write failures
    }
}
/**
 * Check whether all tracked token counters in current_usage are zero.
 */
function isAllUsageZero(usage) {
    if (!usage) {
        return false;
    }
    return ((usage.input_tokens ?? 0) === 0 &&
        (usage.output_tokens ?? 0) === 0 &&
        (usage.cache_creation_input_tokens ?? 0) === 0 &&
        (usage.cache_read_input_tokens ?? 0) === 0);
}
/**
 * Detect the known Claude Code glitch where usage is reported as zero
 * despite a large accumulated input token count.
 */
function isSuspiciousZero(contextWindow) {
    if ((contextWindow.context_window_size ?? 0) <= 0) {
        return false;
    }
    if (contextWindow.used_percentage !== 0) {
        return false;
    }
    const totalInput = contextWindow.total_input_tokens ?? 0;
    return totalInput > SUSPICIOUS_INPUT_THRESHOLD && isAllUsageZero(contextWindow.current_usage);
}
/**
 * Determine whether the current frame contains a usable context snapshot.
 */
function hasGoodContext(contextWindow) {
    return ((contextWindow.context_window_size ?? 0) > 0 &&
        typeof contextWindow.used_percentage === 'number' &&
        contextWindow.used_percentage > 0);
}
/**
 * Merge cached context fields into the current frame.
 * Prefer the frame's context_window_size when already present.
 */
function applyCachedContext(contextWindow, cache) {
    contextWindow.used_percentage = cache.used_percentage;
    contextWindow.remaining_percentage = cache.remaining_percentage ?? null;
    contextWindow.current_usage = cache.current_usage ?? null;
    contextWindow.context_window_size =
        contextWindow.context_window_size ??
            (cache.context_window_size ?? undefined);
}
/**
 * Apply context-window fallback in-place:
 * - For suspicious zero frames, try restoring from cache.
 * - For healthy frames, refresh the cache snapshot.
 */
export function applyContextWindowFallback(stdin, overrides = {}) {
    const contextWindow = stdin.context_window;
    if (!contextWindow) {
        return;
    }
    const deps = { ...defaultDeps, ...overrides };
    const homeDir = deps.homeDir();
    if (isSuspiciousZero(contextWindow)) {
        const cached = readCache(homeDir);
        if (cached) {
            applyCachedContext(contextWindow, cached);
        }
    }
    if (hasGoodContext(contextWindow)) {
        writeCache(homeDir, contextWindow);
    }
}
//# sourceMappingURL=context-cache.js.map