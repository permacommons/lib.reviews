/**
 * Helper utilities around Node 18+ native fetch.
 */

/** Options for {@link fetchWithTimeout}. */
export interface FetchWithTimeoutOptions extends RequestInit {
  timeout?: number;
  label?: string;
  signal?: AbortSignal;
}

/**
 * Wraps `fetch` with optional timeout handling and improved error messages.
 *
 * @param url Request URL or URL object to fetch
 * @param options Optional request options including timeout, label, and signal
 * @returns The Response object from the request
 */
export async function fetchWithTimeout(
  url: string | URL,
  { timeout, label = 'HTTP', signal, ...options }: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const effectiveSignal =
    signal || (typeof timeout === 'number' ? AbortSignal.timeout(timeout) : undefined);

  try {
    return await fetch(url, { ...options, signal: effectiveSignal });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'AbortError' &&
      typeof timeout === 'number'
    )
      throw new Error(`${label} request timed out after ${timeout}ms`);
    throw error;
  }
}

/**
 * Fetches JSON responses while reusing {@link fetchWithTimeout}.
 *
 * @param url Request URL or URL object to fetch
 * @param options Optional request options including timeout, label, and signal
 * @returns Parsed JSON response body
 */
export async function fetchJSON<T = unknown>(
  url: string | URL,
  options: FetchWithTimeoutOptions = {}
): Promise<T> {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const label = options.label || 'HTTP';
    throw new Error(`${label} responded with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}
