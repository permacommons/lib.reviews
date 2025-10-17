'use strict';

module.exports = function flashStore(req, res, next) {
  if (!req || typeof req !== 'object')
    throw new TypeError('Express request object is required for flash storage.');

  if (!req.session)
    return next(new Error('Flash storage requires session middleware to be registered before it.'));

  req.flash = function flash(key, value) {
    if (!key)
      throw new TypeError('Flash key is required');

    if (value === undefined) {
      const store = req.session.flash;
      if (!store)
        return [];

      const messages = Array.isArray(store[key]) ? store[key] : [];
      delete store[key];

      if (Object.keys(store).length === 0)
        Reflect.deleteProperty(req.session, 'flash');

      return messages;
    }

    if (!req.session.flash)
      req.session.flash = Object.create(null);

    if (!Array.isArray(req.session.flash[key]))
      req.session.flash[key] = [];

    req.session.flash[key].push(value);
    return req.session.flash[key];
  };

  next();
};
