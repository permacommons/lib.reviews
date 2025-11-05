import { URL } from 'node:url';

import debug from './debug.ts';

/** Default timeout for webhook POST requests. */
const DEFAULT_TIMEOUT_MS = 10_000;

type FetchImpl = typeof fetch;

type HeadersRecord = Record<string, string>;

type EndpointsByEvent = Record<string, string[]>;

/** Result of a single webhook delivery attempt. */
export interface WebHookDeliveryResult {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** Aggregate response for an event that fanned out to multiple endpoints. */
export interface WebHookDispatchResult {
  event: string;
  deliveries: WebHookDeliveryResult[];
}

/** Configuration knobs for the webhook dispatcher. */
export interface WebHookDispatcherOptions {
  fetch?: FetchImpl;
  timeoutMs?: number;
  logger?: (...args: unknown[]) => void;
}

/**
 * Lightweight webhook dispatcher that posts JSON payloads to configured URLs.
 */
class WebHookDispatcher {
  private readonly _fetch: FetchImpl;
  private readonly _timeoutMs: number;
  private readonly _logger: (...args: unknown[]) => void;
  private readonly _endpoints: Map<string, string[]>;

  constructor(endpointsByEvent: EndpointsByEvent = {}, options: WebHookDispatcherOptions = {}) {
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
   * @param eventName - The webhook event identifier.
   * @param payload - Payload to serialise as JSON.
   * @param headers - Additional HTTP headers for the request.
   */
  async trigger(eventName: string, payload: unknown, headers: HeadersRecord = {}): Promise<WebHookDispatchResult> {
    const endpoints = this._endpoints.get(eventName) || [];
    if (!endpoints.length)
      return { event: eventName, deliveries: [] };

    const mergedHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers);

    const deliveries = await Promise.all(endpoints.map(url =>
      this._deliver(url, payload, mergedHeaders)
    ));

    return { event: eventName, deliveries };
  }

  private async _deliver(url: string, payload: unknown, headers: HeadersRecord): Promise<WebHookDeliveryResult> {
    const delivery: WebHookDeliveryResult = { url, ok: false };

    try {
      // Validate URL before attempting request to catch obvious misconfiguration.
      new URL(url);

      const response = await this._fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this._timeoutMs)
      });

      delivery.status = response.status;
      delivery.ok = response.ok;

      if (response.ok)
        this._logger(`Webhook to ${url} succeeded (status ${response.status}).`);
      else
        this._logger(`Webhook to ${url} responded with ${response.status}.`);
    } catch (error) {
      const errorMessage = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error);
      delivery.error = errorMessage;
      this._logger(`Webhook to ${url} failed: ${errorMessage}`);
    }

    return delivery;
  }
}

export default WebHookDispatcher;
export type { EndpointsByEvent };
