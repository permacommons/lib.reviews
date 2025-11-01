export interface WebHookDeliveryResult {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface WebHookDispatchResult {
  event: string;
  deliveries: WebHookDeliveryResult[];
}

export interface WebHookDispatcherOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  logger?: (...args: unknown[]) => void;
}

declare class WebHookDispatcher {
  constructor(endpointsByEvent?: Record<string, string[]>, options?: WebHookDispatcherOptions);
  trigger(eventName: string, payload: unknown, headers?: Record<string, string>): Promise<WebHookDispatchResult>;
}

export default WebHookDispatcher;
