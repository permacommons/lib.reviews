import type { NextFunction, Request, Response } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { ParsedQs } from 'qs';

import type { AppLocals, TemplateContext } from './locals.ts';

/**
 * Express request typed with the template locals used throughout `routes/`.
 * Route handlers import this alias to get autocomplete for `req.user`,
 * `req.localeChange`, and other shared extensions.
 */
export type HandlerRequest<
  Params extends ParamsDictionary = ParamsDictionary,
  ResBody = unknown,
  ReqBody = Record<string, unknown>,
  ReqQuery extends ParsedQs = ParsedQs,
  Locals extends AppLocals = TemplateContext,
> = Request<Params, ResBody, ReqBody, ReqQuery, Locals>;

/** Express response with locals narrowed to our template context. */
export type HandlerResponse<
  ResBody = unknown,
  Locals extends AppLocals = TemplateContext,
> = Response<ResBody, Locals>;

/** Next function signature pulled from Express. */
export type HandlerNext = NextFunction;

/**
 * Render helper bound to a request/response pair by `routes/helpers/render.ts`.
 */
export type BoundTemplateRenderer = (
  view: string,
  context?: Partial<TemplateContext>,
  jsConfig?: Record<string, unknown>
) => void;

/** Render function used by provider classes to surface common error views. */
export type BoundRenderFunction = (context?: Partial<TemplateContext>) => void;
