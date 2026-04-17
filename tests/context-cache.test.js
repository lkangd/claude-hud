import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyContextWindowFallback } from '../dist/context-cache.js';

async function createTempHome() {
  return await mkdtemp(path.join(tmpdir(), 'claude-hud-context-'));
}

function getCachePath(homeDir) {
  return path.join(homeDir, '.claude', 'plugins', 'claude-hud', 'context-cache.json');
}

test('applyContextWindowFallback applies cached context for suspicious zero frames', async () => {
  const tempHome = await createTempHome();

  try {
    const cachePath = getCachePath(tempHome);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        used_percentage: 61,
        remaining_percentage: 39,
        context_window_size: 200000,
        current_usage: {
          input_tokens: 120000,
          output_tokens: 5000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 800,
        },
        saved_at: Date.now(),
      }),
      'utf8',
    );

    const stdin = {
      context_window: {
        context_window_size: 200000,
        total_input_tokens: 250000,
        used_percentage: 0,
        remaining_percentage: 100,
        current_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };

    applyContextWindowFallback(stdin, { homeDir: () => tempHome });

    assert.equal(stdin.context_window.used_percentage, 61);
    assert.equal(stdin.context_window.remaining_percentage, 39);
    assert.deepEqual(stdin.context_window.current_usage, {
      input_tokens: 120000,
      output_tokens: 5000,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 800,
    });
    assert.equal(stdin.context_window.context_window_size, 200000);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('applyContextWindowFallback keeps suspicious frame unchanged when cache is missing', async () => {
  const tempHome = await createTempHome();

  try {
    const stdin = {
      context_window: {
        context_window_size: 200000,
        total_input_tokens: 250000,
        used_percentage: 0,
        remaining_percentage: 100,
        current_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };

    applyContextWindowFallback(stdin, { homeDir: () => tempHome });

    assert.equal(stdin.context_window.used_percentage, 0);
    assert.equal(stdin.context_window.remaining_percentage, 100);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('applyContextWindowFallback writes cache for good context frames', async () => {
  const tempHome = await createTempHome();

  try {
    const stdin = {
      context_window: {
        context_window_size: 200000,
        total_input_tokens: 120000,
        used_percentage: 58,
        remaining_percentage: 42,
        current_usage: {
          input_tokens: 110000,
          output_tokens: 4000,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 800,
        },
      },
    };

    applyContextWindowFallback(stdin, { homeDir: () => tempHome });

    const cachePath = getCachePath(tempHome);
    assert.equal(existsSync(cachePath), true);
    const cacheContent = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(cacheContent.used_percentage, 58);
    assert.equal(cacheContent.remaining_percentage, 42);
    assert.equal(cacheContent.context_window_size, 200000);
    assert.deepEqual(cacheContent.current_usage, stdin.context_window.current_usage);
    assert.equal(typeof cacheContent.saved_at, 'number');
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('applyContextWindowFallback ignores corrupted cache without throwing', async () => {
  const tempHome = await createTempHome();

  try {
    const cachePath = getCachePath(tempHome);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, '{not-json', 'utf8');

    const stdin = {
      context_window: {
        context_window_size: 200000,
        total_input_tokens: 250000,
        used_percentage: 0,
        remaining_percentage: 100,
        current_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };

    assert.doesNotThrow(() => {
      applyContextWindowFallback(stdin, { homeDir: () => tempHome });
    });
    assert.equal(stdin.context_window.used_percentage, 0);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('applyContextWindowFallback does not treat low-input zero frames as suspicious', async () => {
  const tempHome = await createTempHome();

  try {
    const stdin = {
      context_window: {
        context_window_size: 200000,
        total_input_tokens: 200000,
        used_percentage: 0,
        remaining_percentage: 100,
        current_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };

    applyContextWindowFallback(stdin, { homeDir: () => tempHome });

    assert.equal(stdin.context_window.used_percentage, 0);
    assert.equal(existsSync(getCachePath(tempHome)), false);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('applyContextWindowFallback safely returns when context_window is missing', () => {
  assert.doesNotThrow(() => {
    applyContextWindowFallback({}, { homeDir: () => '/tmp/unused' });
  });
});
