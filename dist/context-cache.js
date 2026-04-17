import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getHudPluginDir } from './claude-config-dir.js';
const CACHE_DIRNAME = 'context-cache';
const SUSPICIOUS_INPUT_THRESHOLD = 200_000;
/**
 * Minimum interval between cache rewrites when the reported usage hasn't changed.
 * Statusline runs every ~300ms so this cuts write frequency by roughly 30x
 * while still keeping the on-disk snapshot fresh for fallback purposes.
 */
const WRITE_TTL_MS = 10_000;
/**
 * Sweep parameters bounding long-term growth of the cache directory.
 * A sweep is attempted probabilistically on cache writes to avoid paying
 * directory-scan cost on every statusline tick.
 */
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const SWEEP_SAMPLE_RATE = 0.01;
const defaultDeps = {
    homeDir: () => os.homedir(),
    now: () => Date.now(),
    random: () => Math.random(),
};
/**
 * Resolve the session-scoped cache file used for context window fallback.
 * Uses a sha256 of the transcript path so that concurrent Claude Code
 * sessions never share or overwrite each other's cached snapshots.
 */
function getCachePath(homeDir, transcriptPath) {
    const hash = createHash('sha256').update(path.resolve(transcriptPath)).digest('hex');
    return path.join(getHudPluginDir(homeDir), CACHE_DIRNAME, `${hash}.json`);
}
/**
 * Resolve the cache directory that holds all session-scoped snapshots.
 */
function getCacheDir(homeDir) {
    return path.join(getHudPluginDir(homeDir), CACHE_DIRNAME);
}
/**
 * Read the last known good context snapshot from disk.
 * Returns null when the cache is missing, malformed, or invalid.
 */
function readCache(homeDir, transcriptPath) {
    try {
        const cachePath = getCachePath(homeDir, transcriptPath);
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
 * Decide whether the current write can be skipped because the on-disk
 * snapshot already records the same used_percentage and is still fresh.
 */
function shouldSkipWrite(cachePath, contextWindow, now) {
    try {
        if (!fs.existsSync(cachePath))
            return false;
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (typeof parsed.used_percentage !== 'number' || typeof parsed.saved_at !== 'number') {
            return false;
        }
        const current = contextWindow.used_percentage ?? 0;
        if (parsed.used_percentage !== current)
            return false;
        return now - parsed.saved_at < WRITE_TTL_MS;
    }
    catch {
        return false;
    }
}
/**
 * Persist a known-good context snapshot for future fallback use.
 * Any write failure is intentionally ignored to keep rendering non-blocking.
 */
function writeCache(homeDir, transcriptPath, contextWindow, now) {
    try {
        const cachePath = getCachePath(homeDir, transcriptPath);
        if (shouldSkipWrite(cachePath, contextWindow, now)) {
            return;
        }
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const payload = {
            used_percentage: contextWindow.used_percentage ?? 0,
            remaining_percentage: contextWindow.remaining_percentage ?? null,
            current_usage: contextWindow.current_usage ?? null,
            context_window_size: contextWindow.context_window_size ?? null,
            saved_at: now,
        };
        fs.writeFileSync(cachePath, JSON.stringify(payload), 'utf8');
    }
    catch {
        // Ignore cache write failures
    }
}
/**
 * Remove stale cache entries and enforce a hard cap on total file count.
 * Safe to run opportunistically; every per-file failure is swallowed.
 */
function sweepCacheDir(cacheDir, now) {
    try {
        if (!fs.existsSync(cacheDir))
            return;
        const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
        const survivors = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json'))
                continue;
            const fullPath = path.join(cacheDir, entry.name);
            try {
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs > MAX_CACHE_AGE_MS) {
                    fs.unlinkSync(fullPath);
                    continue;
                }
                survivors.push({ fullPath, mtimeMs: stat.mtimeMs });
            }
            catch {
                // Ignore per-file failure
            }
        }
        if (survivors.length > MAX_CACHE_ENTRIES) {
            survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
            const toDelete = survivors.length - MAX_CACHE_ENTRIES;
            for (let i = 0; i < toDelete; i += 1) {
                try {
                    fs.unlinkSync(survivors[i].fullPath);
                }
                catch {
                    // Ignore per-file failure
                }
            }
        }
    }
    catch {
        // Ignore top-level sweep errors
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
 * - For suspicious zero frames, try restoring from the session-scoped cache.
 * - For healthy frames, refresh the cache snapshot for this session
 *   (subject to TTL + value-change throttling to avoid hot-path writes).
 *
 * No-op when stdin has no transcript_path, since without a stable session key
 * we cannot safely isolate cache entries across concurrent Claude Code sessions.
 */
export function applyContextWindowFallback(stdin, overrides = {}) {
    const contextWindow = stdin.context_window;
    if (!contextWindow) {
        return;
    }
    const transcriptPath = stdin.transcript_path?.trim();
    if (!transcriptPath) {
        return;
    }
    const deps = { ...defaultDeps, ...overrides };
    const homeDir = deps.homeDir();
    const now = deps.now();
    if (isSuspiciousZero(contextWindow)) {
        const cached = readCache(homeDir, transcriptPath);
        if (cached) {
            applyCachedContext(contextWindow, cached);
        }
    }
    if (hasGoodContext(contextWindow)) {
        writeCache(homeDir, transcriptPath, contextWindow, now);
        if (deps.random() < SWEEP_SAMPLE_RATE) {
            sweepCacheDir(getCacheDir(homeDir), now);
        }
    }
}
/**
 * Test-only entrypoint for deterministically exercising the sweep logic.
 */
export function _sweepCacheForTests(homeDir, now) {
    sweepCacheDir(getCacheDir(homeDir), now);
}
//# sourceMappingURL=context-cache.js.map