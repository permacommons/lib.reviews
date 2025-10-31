import { URL } from 'node:url';
import debug from './debug.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Lightweight webhook dispatcher that posts JSON payloads to configured URLs.
 *
 * @param {Object.<string, string[]>} endpointsByEvent
 *  Mapping of event names to arrays of webhook URLs.
 * @param {Object} [options]
 * @param {Function} [options.fetch] override for fetch (defaults to globalThis.fetch)
 * @param {number} [options.timeoutMs] request timeout in milliseconds
 */
class WebHookDispatcher {
  constructor(endpointsByEvent = {}, options = {}) {
    if (!endpointsByEvent || typeof endpointsByEvent !== 'object')
      throw new TypeError('Webhook configuration must be an object keyed by event name.');

    this._fetch = options.fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function')
      throw new TypeError('A fetch implementation must be provided.');

    this._timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._logger = options.logger || debug.webhooks;

    this._endpoints = new Map();
    for (const [eventName, urls] of Object.entries(endpointsByEvent)) {
      if (!Array.isArray(urls) || urls.length === 0)
        continue;

      const normalized = urls
        .filter(url => typeof url === 'string' && url.trim().length)
        .map(url => url.trim());

      if (normalized.length)
        this._endpoints.set(eventName, normalized);
    }
  }

  /**
   * Trigger a webhook event and POST the payload to all configured URLs.
   *
   * @param {string} eventName - The webhook event identifier.
   * @param {Object} payload - Payload to serialise as JSON.
   * @param {Object} [headers] - Additional HTTP headers for the request.
   * @returns {Promise<{event: string, deliveries: Array<{url: string, ok: boolean, status: (number|undefined), error: (string|undefined)}>}>}
   *  Summary of delivery attempts (always resolves, never rejects).
   */
  async trigger(eventName, payload, headers = {}) {
    const endpoints = this._endpoints.get(eventName) || [];
    if (!endpoints.length)
      return { event: eventName, deliveries: [] };

    const mergedHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers);

    const deliveries = await Promise.all(endpoints.map(url =>
      this._deliver(url, payload, mergedHeaders)
    ));

    return { event: eventName, deliveries };
  }

  async _deliver(url, payload, headers) {
    const delivery = { url, ok: false };

    try {
      // Validate URL before attempting request to catch obvious misconfiguration.
      // eslint-disable-next-line no-new
      new URL(url);

      const response = await this._fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this._timeoutMs)
      });

      delivery.status = response.status;
      delivery.ok = response.ok;

      if (response.ok) {
        this._logger(`Webhook to ${url} succeeded (status ${response.status}).`);
      } else {
        this._logger(`Webhook to ${url} responded with ${response.status}.`);
      }
    } catch (error) {
      delivery.error = error && error.message ? error.message : String(error);
      this._logger(`Webhook to ${url} failed: ${delivery.error}`);
    }

    return delivery;
  }
}

export default WebHookDispatcher;
