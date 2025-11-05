import express from 'express';
import type {
  BoundRenderFunction,
  BoundTemplateRenderer,
  HandlerNext,
  HandlerRequest,
  HandlerResponse,
} from '../../types/http/handlers.ts';
import forms from '../helpers/forms.ts';
// Internal dependencies
import render from '../helpers/render.ts';
import getResourceErrorHandler from './resource-error-handler.ts';

const router = express.Router();

type ProviderRequest = HandlerRequest;
type ProviderResponse = HandlerResponse;

type PreFlightCheck = (this: AbstractBREADProvider) => boolean;
type ActionHandler<T = unknown> = (this: AbstractBREADProvider, data?: T) => unknown;
type LoadDataHandler<T = unknown> = (this: AbstractBREADProvider) => Promise<T>;

type PermissionCheck<T = unknown> = (this: AbstractBREADProvider, data: T) => boolean;

interface BreadAction<T = unknown> {
  GET?: ActionHandler<T>;
  POST?: ActionHandler<T>;
  preFlightChecks: PreFlightCheck[];
  loadData?: LoadDataHandler<T>;
  resourcePermissionCheck?: PermissionCheck<T>;
  titleKey?: string;
}

interface BakeRouteDefinition {
  path: string;
  methods: string[];
}

interface BakeRouteMap {
  [action: string]: BakeRouteDefinition;
}

interface ProviderOptions {
  action?: string;
  method?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * This is a generic class to provide middleware for Browse/Read/Edit/Add/Delete
 * operations and forms. It comes with some baked-in pre-flight checks but needs
 * to be extended to do useful work. All default actions except reads require
 * being logged in.
 *
 * Use the bakery method to create standard BREAD routes. :)
 */
type ParseSubmissionFn = (
  options?: Parameters<typeof forms.parseSubmission>[1]
) => ReturnType<typeof forms.parseSubmission>;

class AbstractBREADProvider {
  protected readonly req: ProviderRequest;
  protected readonly res: ProviderResponse;
  protected readonly next: HandlerNext;
  protected readonly actions: Record<string, BreadAction>;
  protected messageKeyPrefix: string;
  protected action: string;
  protected method: string;
  protected id?: string;
  [key: string]: unknown;

  protected renderTemplate: BoundTemplateRenderer;
  protected renderResourceError: BoundRenderFunction;
  protected renderPermissionError: BoundRenderFunction;
  protected renderSigninRequired: BoundRenderFunction;
  protected getResourceErrorHandler: (
    messageKeyPrefix: string,
    bodyParam: string
  ) => (error: unknown) => void;
  protected parseForm: ParseSubmissionFn;

  /**
   * @param req
   *  Express request
   * @param res
   *  Express response
   * @param next
   *  Express callback to move on to next middleware
   * @param options
   *  What kind of route to create
   * @param options.action='add'
   *  one of 'browse', 'read' (view), 'add' (create), 'edit', 'delete'
   * @param options.method='GET'
   *  what HTTP method this route responds to
   * @param options.id
   *  if required, what object ID to look up
   * @param options.someOtherID
   *  will also be assigned to `this`
   */
  constructor(
    req: ProviderRequest,
    res: ProviderResponse,
    next: HandlerNext,
    options: ProviderOptions = {}
  ) {
    if (new.target === AbstractBREADProvider)
      throw new TypeError(
        'AbstractBREADProvider is an abstract class, please instantiate a derived class.'
      );

    if (!req || !res || !next)
      throw new Error('Form needs at least req, res, and next functions from middleware.');

    this.actions = {
      browse: {
        // Function to call for GET requests
        GET: this.browse_GET,
        // Checks to perform before either of above functions are called.
        // If checks fail, they are not called (checks have to handle
        // the request).
        preFlightChecks: [],
        // Title for all "browse" actions
        titleKey: undefined,
      },
      read: {
        GET: this.read_GET,
        preFlightChecks: [],
        // Function to call to load data and pass it to GET/POST function.
        // This must perform exclusion of deleted or stale revisions.
        loadData: this.loadData,
        titleKey: undefined,
      },
      add: {
        GET: this.add_GET,
        // Function to call for POST requests
        POST: this.add_POST,
        preFlightChecks: [this.userIsSignedIn],
        titleKey: undefined,
      },
      edit: {
        GET: this.edit_GET,
        POST: this.edit_POST,
        preFlightChecks: [this.userIsSignedIn],
        // Function to call to load data and pass it to GET/POST function
        loadData: this.loadData,
        // Function to call to validate that user can perform this action,
        // once we have a resource to check against.
        resourcePermissionCheck: this.userCanEdit,
        titleKey: undefined,
      },
      delete: {
        GET: this.delete_GET,
        POST: this.delete_POST,
        preFlightChecks: [this.userIsSignedIn],
        loadData: this.loadData,
        resourcePermissionCheck: this.userCanDelete,
        titleKey: undefined,
      },
    };

    // Middleware functions
    this.req = req;
    this.res = res;
    this.next = next;

    // This is used for "not found" messages that must be in the format
    // "x not found" (for the body) and "x not found title" (for the title)
    this.messageKeyPrefix = '';

    // Defaults
    const resolvedOptions = Object.assign(
      {
        action: 'add',
        method: 'GET',
        id: undefined, // only for edit/delete operations
      },
      options
    );

    Object.assign(this, resolvedOptions);

    this.action = String(resolvedOptions.action ?? 'add');
    this.method = String(resolvedOptions.method ?? 'GET');
    this.id =
      typeof resolvedOptions.id === 'string' || resolvedOptions.id === undefined
        ? (resolvedOptions.id as string | undefined)
        : String(resolvedOptions.id);

    // Shortcuts to common helpers, which also lets us override these with
    // custom methods if appropriate
    this.renderTemplate = render.template.bind(render, this.req, this.res) as BoundTemplateRenderer;
    this.renderResourceError = render.resourceError.bind(
      render,
      this.req,
      this.res
    ) as BoundRenderFunction;
    this.renderPermissionError = render.permissionError.bind(
      render,
      this.req,
      this.res
    ) as BoundRenderFunction;
    this.renderSigninRequired = render.signinRequired.bind(
      render,
      this.req,
      this.res
    ) as BoundRenderFunction;
    this.getResourceErrorHandler = getResourceErrorHandler.bind(
      getResourceErrorHandler,
      this.req,
      this.res,
      this.next
    );
    this.parseForm = forms.parseSubmission.bind(forms, this.req) as ParseSubmissionFn;
  }

  execute(): void {
    const actions = Object.keys(this.actions);
    if (actions.indexOf(this.action) === -1)
      throw new Error('Did not recognize form action: ' + this.action);

    if (typeof this.actions[this.action][this.method] !== 'function')
      throw new Error('No defined handler for this method.');

    // Perform pre-flight checks (e.g., permission checks). Pre-flight checks
    // are responsible for rendering failure/result messages, so no
    // additional rendering will take place if any checks fail.
    let mayProceed = true;

    for (const check of this.actions[this.action].preFlightChecks) {
      const result = Reflect.apply(check, this, []);
      if (!result) {
        mayProceed = false;
        break; // First check to fail will be responsible for rendering error
      }
    }

    if (!mayProceed) return;

    const actionDef = this.actions[this.action];

    if (!actionDef.loadData)
      Reflect.apply(actionDef[this.method] as ActionHandler, this, []); // Call appropriate handler
    else {
      // Asynchronously load data and show 404 if not found
      Reflect.apply(actionDef.loadData, this, [])
        .then(data => {
          // If we have a permission check, only proceeds if it succeeds.
          // If we don't have a permission check, proceed.
          if (
            !actionDef.resourcePermissionCheck ||
            Reflect.apply(actionDef.resourcePermissionCheck, this, [data])
          )
            Reflect.apply(actionDef[this.method] as ActionHandler, this, [data]);
        })
        .catch(this.getResourceErrorHandler(this.messageKeyPrefix, this.id ? String(this.id) : ''));
    }
  }

  browse_GET(_data?: unknown): void | Promise<void> {
    throw new Error('browse_GET must be implemented by subclasses.');
  }

  read_GET(_data?: unknown): void | Promise<void> {
    throw new Error('read_GET must be implemented by subclasses.');
  }

  add_GET(_formValues?: unknown, _data?: unknown): void | Promise<void> {
    throw new Error('add_GET must be implemented by subclasses.');
  }

  add_POST(_data?: unknown): void | Promise<void> {
    throw new Error('add_POST must be implemented by subclasses.');
  }

  edit_GET(_data?: unknown): void | Promise<void> {
    throw new Error('edit_GET must be implemented by subclasses.');
  }

  edit_POST(_data?: unknown): void | Promise<void> {
    throw new Error('edit_POST must be implemented by subclasses.');
  }

  delete_GET(_data?: unknown): void | Promise<void> {
    throw new Error('delete_GET must be implemented by subclasses.');
  }

  delete_POST(_data?: unknown): void | Promise<void> {
    throw new Error('delete_POST must be implemented by subclasses.');
  }

  loadData(): Promise<any> {
    return Promise.reject(new Error('loadData must be implemented by subclasses.'));
  }

  userIsSignedIn(): boolean {
    if (!this.req.user) {
      this.renderSigninRequired({
        titleKey: this.actions[this.action].titleKey,
      });
      return false;
    } else return true;
  }

  userIsTrusted(): boolean {
    if (!this.req.user || !this.req.user.isTrusted) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey,
        detailsKey: 'must be trusted',
      });
      return false;
    } else return true;
  }

  userCan(action: string, data: any): boolean {
    if (typeof data.populateUserInfo === 'function') data.populateUserInfo(this.req.user);
    if (action === 'edit' && data.userCanEdit) return true;
    else if (action === 'delete' && data.userCanDelete) return true;
    else {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey,
      });
      return false;
    }
  }

  userCanEdit(data: any): boolean {
    return this.userCan('edit', data);
  }

  userCanDelete(data: any): boolean {
    return this.userCan('delete', data);
  }

  // Adds a pre-flight check to all actions in provided array.
  // If not defined, adds to all actions
  addPreFlightCheck(actions: string[] | undefined, check: PreFlightCheck): void {
    const targetActions = actions ?? Object.keys(this.actions);

    for (const action of targetActions) this.actions[action].preFlightChecks.push(check);
  }

  static getDefaultRoutes(resource: string): BakeRouteMap {
    // The default does not (yet) include a browse route.
    // The code below parses the IDs in the route, so be careful adding
    // non-standard patterns.
    return {
      add: {
        path: `/new/${resource}`,
        methods: ['GET', 'POST'],
      },
      read: {
        path: `/${resource}/:id`,
        methods: ['GET'],
      },
      edit: {
        path: `/${resource}/:id/edit`,
        methods: ['GET', 'POST'],
      },
      delete: {
        path: `/${resource}/:id/delete`,
        methods: ['GET', 'POST'],
      },
    };
  }

  // This registers default routes that are common for editable resources,
  // following a standard pattern.
  //
  // resource -- the identifier used in URLs for the resource
  //  that is being configured.
  //
  // routes (optional) -- actions and associated Express routes that we want to
  //   set up. POST routes will only be created for add/edit/delete actions.
  static bakeRoutes(this: typeof AbstractBREADProvider, resource: string, routes?: BakeRouteMap) {
    const Provider = this as typeof AbstractBREADProvider &
      (new (
        req: ProviderRequest,
        res: ProviderResponse,
        next: HandlerNext,
        options?: ProviderOptions
      ) => AbstractBREADProvider);

    const resolvedRoutes = routes ?? this.getDefaultRoutes(resource);

    function bakeRoute(action: string, method: string, idArray: string[]) {
      return (req: ProviderRequest, res: ProviderResponse, next: HandlerNext) => {
        const options: ProviderOptions = {
          action,
          method,
        };

        // We always initialize each provider with the provided IDs,
        // ready for use as object properties.
        idArray.forEach(id => (options[id] = req.params[id]));

        const provider = new Provider(req, res, next, options);

        provider.execute();
      };
    }

    for (const action in resolvedRoutes) {
      // Extract variable placeholders
      const idMatches = resolvedRoutes[action].path.match(/\/(:(.*?))(\/|$)/g);
      // Extract variable names
      const idArray = idMatches ? idMatches.map(id => id.match(/\w+/)?.[0] ?? '') : [];

      // Register router function for each specified method (GET, POST, etc.).
      // The router methods like router.get() are lower case.
      for (const method of resolvedRoutes[action].methods)
        (router as any)[method.toLowerCase()](
          resolvedRoutes[action].path,
          bakeRoute(action, method, idArray)
        );
    }

    return router;
  }
}

export default AbstractBREADProvider;
