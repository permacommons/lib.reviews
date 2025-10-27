'use strict';
const thinky = require('../../db');
const r = thinky.r;
const type = thinky.type;

/**
 * Common handler functions for managing revisions. These are typically attached
 * to models as static or instance methods, see models-legacy/thing.js for examples.
 *
 * @namespace Revision
 */

const revision = {

  /**
   * Get a function that lets us create a new revision (including saving a copy
   * of the current revision) for the given Model
   *
   * @param {Model} Model
   *  the Model we need a handler for
   * @returns {Function}
   *  function that can be attached as an instance method to the Model via
   *  `Model.define`. See {@link Revision~_newRevision}.
   * @memberof Revision
   */
  getNewRevisionHandler(Model) {

    /**
     * Function obtained via {@link Revision.getNewRevisionHandler}.
     * Save a copy of the current revision as an old revision and create (but
     * do not save) a new revision object.
     *
     * @param {User} user
     *  the user to associate with this revision
     * @param {Object} [options]
     *  revision options
     * @param {String[]} options.tags
     *  set of tags to associate with this revision
     * @returns {Model}
     *  new revision of the given Model
     * @memberof Revision
     * @inner
     * @this model
     */
    const _newRevision = async function(user, { tags } = {}) {
      let newRev = this;
      // Archive current revision
      let oldRev = new Model(newRev);
      oldRev._oldRevOf = newRev.id;
      oldRev.id = undefined;
      await oldRev.save();
      const uuid = await r.uuid();
      newRev._revID = uuid;
      newRev._revUser = user.id;
      newRev._revDate = new Date();
      newRev._revTags = tags;
      return newRev;
    };
    return _newRevision;
  },

  /**
   * Shortcut for a filter operation that narrows a table to current revisions,
   * commonly chained with other filters.
   *
   * @param {Model} Model
   *  the table to filter
   * @returns {Function}
   *  function that returns a Query object for this Model
   * @memberof Revision
   */
  getNotStaleOrDeletedFilterHandler(Model) {

    /**
     * Function obtained via {@link Revision.getNotStaleOrDeletedFilterHandler}.
     *
     * @returns {Query}
     *  revisions that are not flagged as outdated or deleted
     * @memberof Revision
     * @inner
     */
    const _filterNotStaleOrDeleted = () => Model
      .filter({ _oldRevOf: false }, { default: true })
      .filter({ _revDeleted: false }, { default: true });
    return _filterNotStaleOrDeleted;
  },

  /**
   * Shortcut for a getAll/filter operation that returns objects matching a
   * given list of IDs.
   *
   * @param {Model} Model
   *  the table to filter
   * @returns {Function}
   *  function that returns a Query object for this Model
   * @memberof Revision
   */
  getMultipleNotStaleOrDeletedHandler(Model) {

    /**
     * Function obtained via {@link Revision.getMultipleNotStaleOrDeletedHandler}.
     *
     * @returns {Query}
     *  objects that are not flagged as outdated or deleted
     * @param {String[]} idArray
     *  an array of primary key IDs
     * @memberof Revision
     * @inner
     */
    const getMultipleNotStaleOrDeleted = idArray => Model
      .getAll(...idArray, { index: 'id' })
      .filter({ _revDeleted: false }, { default: true })
      .filter({ _oldRevOf: false }, { default: true });
    return getMultipleNotStaleOrDeleted;
  },

  /**
   * Get handler to `.get()` an object by its ID and reject with standardized
   * error if it is an old or deleted revision.
   *
   * @param {Model} Model
   *  the table to query with this handler
   * @returns {Function}
   *  function we can attach as a static method to the Model via
   * `Model.getNotStaleOrDeleted = fn`. See
   * {@link Revision~_getNotStaleOrDeleted}.
   * @memberof Revision
   */
  getNotStaleOrDeletedGetHandler(Model) {

    /**
     * Function obtained via {@link Revision.getNotStaleOrDeletedGetHandler}.
     *
     * @param {String} id
     *  the ID to look up
     * @param {Object} [join]
     *  an object specifying a join to another table
     * @returns {Model}
     *  an object of the specified Model
     * @memberof Revision
     * @inner
     */
    const _getNotStaleOrDeleted = async (id, join) => {
      let data;
      if (typeof join == 'object')
        data = await Model.get(id).getJoin(join);
      else
        data = await Model.get(id);

      if (data._revDeleted)
        throw revision.deletedError;
      else if (data._oldRevOf)
        throw revision.staleError;
      else
        return data;
    };
    return _getNotStaleOrDeleted;
  },


  /**
   * Get a function that lets us create the first revision of a given model.
   * Does not save.
   *
   * @param {Model} Model
   *  the Model we want to attach the handler to
   * @returns {Function}
   *  function we can attach as a static method to the Model via
   *  `Model.createFirstRevision = fn`. See
   *  {@link Revision~_createFirstRevision}.
   * @memberof Revision
   */
  getFirstRevisionHandler(Model) {

    /**
     * Function obtained via {@link Revision.getFirstRevisionHandler}.
     * Create (but don't save) the initial revision for an object of this Model.
     * Asynchronously obtains UUID.
     *
     * @param {User} user
     *  the user to associate with this revision
     * @param {Object} [options]
     *  revision options
     * @param {String[]} options.tags
     *  set of tags to associate with this revision
     * @returns {Model}
     *  first revision
     * @memberof Revision
     * @inner
     */
    const _createFirstRevision = async function(user, { tags } = {}) {
      let firstRev = new Model({});
      const uuid = await r.uuid();
      firstRev._revID = uuid;
      firstRev._revUser = user.id;
      firstRev._revDate = new Date();
      firstRev._revTags = tags;
      return firstRev;
    };
    return _createFirstRevision;
  },


  /**
   * Get a function that lets us mark all revisions of a given object as
   * deleted (they are not actually removed) and save the deletion metadata
   * as a new revision.
   *
   * @param {Model} Model
   *  the Model we want to attach the handler to
   * @returns {Function}
   *  function we can attach as an instance method via `Model.define`. See
   *  {@link Revision~_deleteAllRevisions}.
   * @memberof Revision
   */
  getDeleteAllRevisionsHandler(Model) {


    /**
     * Function obtained via {@link Revision.getDeleteAllRevisionsHandler}.
     * Creates and saves a new revision with deletion metadata as well.
     *
     * @param {User} user
     *  the user we want to associate with this deletion action
     * @param {Object} [options]
     *  revision options
     * @param {String[]} options.tags
     *  set of tags to associate with the deletion revision. The first tag will
     *  always be 'delete', but you can specify, e.g., the method by which
     *  the deletion occurred.
     * @returns {Model}
     *  revision with deletion metadata
     * @memberof Revision
     * @inner
     */
    const _deleteAllRevisions = async function(user, {
      tags = []
    } = {}) {
      const id = this.id;
      tags.unshift('delete');

      // A deletion results in a new revision which contains
      // information about the deletion itself (date, user who
      // performed it, tags, etc.)
      const rev = await this.newRevision(user, { tags });
      rev._revDeleted = true;
      await rev.save();

      // Update all other rows
      await Model.filter({ _oldRevOf: id }).update({ _revDeleted: true });
      return rev;
    };
    return _deleteAllRevisions;
  },


  /**
   * Obtain a copy of the standard revision schema.
   *
   * @returns {Object}
   *  object that can be assigned via Object.assign to the schema object
   *  for your Model
   * @memberof Revision
   */
  getSchema() {
    return {
      _revUser: type
        .string()
        .required(true),
      _revDate: type
        .date()
        .required(true),
      _revID: type
        .string()
        .uuid(4)
        .required(true), // Set this for all revisions, including current
      _oldRevOf: type.string(), // Only set if it's an old revision of an existing thing
      _revDeleted: type.boolean(), // Set to true for all deleted revisions (not all revisions have to be deleted)
      _revTags: [type.string()] // Optional tags to describe action performed through this revision, e.g. edit, delete, etc.
    };
  }
};

revision.deletedError = new Error('Revision has been deleted.');
revision.staleError = new Error('Outdated revision.');
revision.deletedError.name = 'RevisionDeletedError';
revision.staleError.name = 'RevisionStaleError';

module.exports = revision;
