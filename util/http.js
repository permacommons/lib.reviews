'use strict';

/**
 * Helper utilities around Node 18+ native fetch.
 */

async function fetchWithTimeout(url, {
  timeout,
  label = 'HTTP',
  signal,
  ...options
} = {}) {
  const effectiveSignal = signal ||
    (typeof timeout === 'number' ? AbortSignal.timeout(timeout) : undefined);

  try {
    return await fetch(url, { ...options, signal: effectiveSignal });
  } catch (error) {
    if (error && error.name === 'AbortError' && typeof timeout === 'number')
      throw new Error(`${label} request timed out after ${timeout}ms`);
    throw error;
  }
}

async function fetchJSON(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const label = options.label || 'HTTP';
    throw new Error(`${label} responded with status ${response.status}`);
  }
  return response.json();
}

module.exports = {
  fetchWithTimeout,
  fetchJSON
};
