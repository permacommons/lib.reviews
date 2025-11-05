import type { NextFunction, Request, Response } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { ParsedQs } from 'qs';

import type { AppLocals, TemplateContext } from './locals.ts';

export type HandlerRequest<
  Params extends ParamsDictionary = ParamsDictionary,
  ResBody = unknown,
  ReqBody = Record<string, unknown>,
  ReqQuery extends ParsedQs = ParsedQs,
  Locals extends AppLocals = TemplateContext,
> = Request<Params, ResBody, ReqBody, ReqQuery, Locals>;

export type HandlerResponse<
  ResBody = unknown,
  Locals extends AppLocals = TemplateContext,
> = Response<ResBody, Locals>;

export type HandlerNext = NextFunction;

export type BoundTemplateRenderer = (
  view: string,
  context?: Partial<TemplateContext>,
  jsConfig?: Record<string, unknown>
) => void;

export type BoundRenderFunction = (context?: Partial<TemplateContext>) => void;
