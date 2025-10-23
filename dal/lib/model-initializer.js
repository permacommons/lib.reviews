'use strict';
const { getOrCreateModel } = require('./model-factory');
const revision = require('./revision');
const DEFAULT_REVISION_STATIC = ['createFirstRevision', 'getNotStaleOrDeleted', 'filterNotStaleOrDeleted'];
const DEFAULT_REVISION_INSTANCE = ['deleteAllRevisions'];
const REVISION_HANDLER_MAP = {
  createFirstRevision: revision.getFirstRevisionHandler,
  getNotStaleOrDeleted: revision.getNotStaleOrDeletedGetHandler,
  filterNotStaleOrDeleted: revision.getNotStaleOrDeletedFilterHandler,
  getMultipleNotStaleOrDeleted: revision.getMultipleNotStaleOrDeletedHandler,
  newRevision: revision.getNewRevisionHandler,
  deleteAllRevisions: revision.getDeleteAllRevisionsHandler
};

function initializeModel({
  dal,
  baseTable,
  schema,
  camelToSnake = {},
  withRevision = false,
  staticMethods = {},
  instanceMethods = {},
  registryKey
}) {
  if (!dal) throw new Error('Model initialization requires a DAL instance');
  if (!baseTable) throw new Error('Model initialization requires a base table name');

  const tableName = dal.tablePrefix ? `${dal.tablePrefix}${baseTable}` : baseTable;
  const { model, isNew } = getOrCreateModel(dal, tableName, schema, { registryKey: registryKey || baseTable });
  if (!isNew) return { model, isNew, tableName };
  for (const [camel, snake] of Object.entries(camelToSnake)) model._registerFieldMapping(camel, snake);
  if (withRevision) attachRevisionHandlers(model, normalizeRevisionConfig(withRevision));
  for (const [name, fn] of Object.entries(staticMethods)) if (typeof fn === 'function') model[name] = fn;
  for (const [name, fn] of Object.entries(instanceMethods)) {
    if (typeof fn !== 'function') continue;
    if (typeof model.define === 'function') model.define(name, fn); else model.prototype[name] = fn;
  }
  return { model, isNew, tableName };
}

const toArray = (value, fallback) => (Array.isArray(value) ? value : fallback);

function normalizeRevisionConfig(config) {
  if (config === true) return { static: DEFAULT_REVISION_STATIC, instance: DEFAULT_REVISION_INSTANCE };
  if (!config) return null;
  return { static: toArray(config.static, DEFAULT_REVISION_STATIC), instance: toArray(config.instance, DEFAULT_REVISION_INSTANCE) };
}

function attachRevisionHandlers(model, config) {
  if (!config) return;
  for (const name of config.static) {
    const factory = REVISION_HANDLER_MAP[name];
    if (typeof factory === 'function') model[name] = factory(model);
  }
  for (const name of config.instance) {
    const factory = REVISION_HANDLER_MAP[name];
    if (typeof factory !== 'function') continue;
    if (typeof model.define === 'function') model.define(name, factory(model)); else model.prototype[name] = factory(model);
  }
}

module.exports = {
  initializeModel
};
