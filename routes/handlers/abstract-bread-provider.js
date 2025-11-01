import express from 'express';

// Internal dependencies
import render from '../helpers/render.ts';
import forms from '../helpers/forms.ts';
import getResourceErrorHandler from './resource-error-handler.js';

const router = express.Router();


/**
 * This is a generic class to provide middleware for Browse/Read/Edit/Add/Delete
 * operations and forms. It comes with some baked-in pre-flight checks but needs
 * to be extended to do useful work. All default actions except reads require
 * being logged in.
 *
 * Use the bakery method to create standard BREAD routes. :)
 */
class AbstractBREADProvider {

  /**
   * @param {IncomingMessage} req
   *  Express request
   * @param {ServerResponse} res
   *  Express response
   * @param {Function} next
   *  Express callback to move on to next middleware
   * @param {Object} [options]
   *  What kind of route to create
   * @param {String} options.action='add'
   *  one of 'browse', 'read' (view), 'add' (create), 'edit', 'delete'
   * @param {String} options.method='GET'
   *  what HTTP method this route responds to
   * @param {String} options.id
   *  if required, what object ID to look up
   * @param {String} options.someOtherID
   *  will also be assigned to `this`
   */
  constructor(req, res, next, options) {
    if (new.target === AbstractBREADProvider)
      throw new TypeError('AbstractBREADProvider is an abstract class, please instantiate a derived class.');

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
        titleKey: undefined
      },
      read: {
        GET: this.read_GET,
        preFlightChecks: [],
        // Function to call to load data and pass it to GET/POST function.
        // This must perform exclusion of deleted or stale revisions.
        loadData: this.loadData,
        titleKey: undefined
      },
      add: {
        GET: this.add_GET,
        // Function to call for POST requests
        POST: this.add_POST,
        preFlightChecks: [this.userIsSignedIn],
        titleKey: undefined
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
        titleKey: undefined
      },
      delete: {
        GET: this.delete_GET,
        POST: this.delete_POST,
        preFlightChecks: [this.userIsSignedIn],
        loadData: this.loadData,
        resourcePermissionCheck: this.userCanDelete,
        titleKey: undefined
      }
    };

    // Middleware functions
    this.req = req;
    this.res = res;
    this.next = next;

    // This is used for "not found" messages that must be in the format
    // "x not found" (for the body) and "x not found title" (for the title)
    this.messageKeyPrefix = '';

    // Defaults
    options = Object.assign({
      action: 'add',
      method: 'GET',
      id: undefined // only for edit/delete operations
    }, options);

    Object.assign(this, options);

    // Shortcuts to common helpers, which also lets us override these with
    // custom methods if appropriate
    this.renderTemplate = render.template.bind(render, this.req, this.res);
    this.renderResourceError = render.resourceError.bind(render, this.req, this.res);
    this.renderPermissionError = render.permissionError.bind(render, this.req, this.res);
    this.renderSigninRequired = render.signinRequired.bind(render, this.req, this.res);
    this.getResourceErrorHandler = getResourceErrorHandler.bind(getResourceErrorHandler, this.req, this.res, this.next);
    this.parseForm = forms.parseSubmission.bind(forms, this.req);

  }

  execute() {

    let actions = Object.keys(this.actions);
    if (actions.indexOf(this.action) == -1)
      throw new Error('Did not recognize form action: ' + this.type);

    if (typeof this.actions[this.action][this.method] != 'function')
      throw new Error('No defined handler for this method.');

    // Perform pre-flight checks (e.g., permission checks). Pre-flight checks
    // are responsible for rendering failure/result messages, so no
    // additional rendering will take place if any checks fail.
    let mayProceed = true;

    for (let check of this.actions[this.action].preFlightChecks) {
      let result = Reflect.apply(check, this, []);
      if (!result) {
        mayProceed = false;
        break; // First check to fail will be responsible for rendering error
      }
    }

    if (!mayProceed)
      return;

    if (!this.actions[this.action].loadData)
      Reflect.apply(this.actions[this.action][this.method], this, []); // Call appropriate handler
    else {
      // Asynchronously load data and show 404 if not found
      Reflect.apply(this.actions[this.action].loadData, this, [])
        .then(data => {

          // If we have a permission check, only proceeds if it succeeds.
          // If we don't have a permission check, proceed.
          if (!this.actions[this.action].resourcePermissionCheck ||
            Reflect.apply(this.actions[this.action].resourcePermissionCheck, this, [data]))

            Reflect.apply(this.actions[this.action][this.method], this, [data]);

        })
        .catch(this.getResourceErrorHandler(this.messageKeyPrefix, this.id));
    }

  }

  userIsSignedIn() {
    if (!this.req.user) {
      this.renderSigninRequired({
        titleKey: this.actions[this.action].titleKey
      });
      return false;
    } else
      return true;
  }

  userIsTrusted() {
    if (!this.req.user || !this.req.user.isTrusted) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey,
        detailsKey: "must be trusted",
      });
      return false;
    } else
      return true;
  }

  userCan(action, data) {
    data.populateUserInfo(this.req.user);
    if (action == 'edit' && data.userCanEdit)
      return true;
    else if (action == 'delete' && data.userCanDelete)
      return true;
    else {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });
      return false;
    }
  }

  userCanEdit(data) {
    return this.userCan('edit', data);
  }

  userCanDelete(data) {
    return this.userCan('delete', data);
  }

  // Adds a pre-flight check to all actions in provided array.
  // If not defined, adds to all actions
  addPreFlightCheck(actions, check) {
    if (!actions)
      actions = Object.keys(this.actions);

    for (let action of actions)
      this.actions[action].preFlightChecks.push(check);
  }

}

AbstractBREADProvider.getDefaultRoutes = function(resource) {
  // The default does not (yet) include a browse route.
  // The code below parses the IDs in the route, so be careful adding
  // non-standard patterns.
  return {
    add: {
      path: `/new/${resource}`,
      methods: ['GET', 'POST']
    },
    read: {
      path: `/${resource}/:id`,
      methods: ['GET']
    },
    edit: {
      path: `/${resource}/:id/edit`,
      methods: ['GET', 'POST']
    },
    delete: {
      path: `/${resource}/:id/delete`,
      methods: ['GET', 'POST']
    }
  };
};

// This registers default routes that are common for editable resources,
// following a standard pattern.
//
// resource -- the identifier used in URLs for the resource
//  that is being configured.
//
// routes (optional) -- actions and associated Express routes that we want to
//   set up. POST routes will only be created for add/edit/delete actions.
AbstractBREADProvider.bakeRoutes = function(resource, routes) {

  let Provider = this;

  if (!routes)
    routes = this.getDefaultRoutes(resource);

  function _bakeRoute(action, method, idArray) {

    return function(req, res, next) {

      let options = {
        action,
        method
      };

      // We always initialize each provider with the provided IDs,
      // ready for use as object properties.
      idArray.forEach(id => (options[id] = req.params[id]));

      let provider = new Provider(req, res, next, options);

      provider.execute();
    };
  }

  for (let action in routes) {
    // Extract variable placeholders
    let idMatches = routes[action].path.match(/\/:(.*?)(\/|$)/g);
    // Extract variable names
    let idArray = idMatches ? idMatches.map(id => id.match(/\w+/)[0]) : [];

    // Register router function for each specified method (GET, POST, etc.).
    // The router methods like router.get() are lower case.
    for (let method of routes[action].methods)
      router[method.toLowerCase()](routes[action].path,
        _bakeRoute(action, method, idArray));

  }

  return router;

};

export default AbstractBREADProvider;
