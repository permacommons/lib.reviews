import type { Request, Response } from 'express';

export type MockRequest = Request;

export type MockResponse = Response & {
  redirects: string[];
};

export interface CreateMockResponseOptions {
  onRedirect?: (url: string) => void;
}

export const createMockRequest = (overrides: Partial<Request> = {}): MockRequest => {
  const request = {
    originalUrl: '/',
    ...overrides,
  } as Partial<Request>;

  return request as Request;
};

export const createMockResponse = (options: CreateMockResponseOptions = {}): MockResponse => {
  const redirects: string[] = [];
  const response = {
    redirects,
  } as Partial<Response> & { redirects: string[] };

  const redirectImpl = ((statusOrUrl: number | string, maybeUrl?: string) => {
    const url = typeof statusOrUrl === 'number' ? maybeUrl : statusOrUrl;
    if (url) {
      redirects.push(url);
      options.onRedirect?.(url);
    }
    return response as Response;
  }) as Response['redirect'];

  response.redirect = redirectImpl;

  return response as MockResponse;
};
