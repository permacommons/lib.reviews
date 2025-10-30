const api = {

  // Set the API flag for API requests, and ensure all API requests come either
  // from a browser or an application.
  prepareRequest(req, res, next) {
    req.isAPI = true;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.get('x-requested-with') != 'XMLHttpRequest' &&
      req.get('x-requested-with') != 'app') {
      let response = {};
      response.message = 'Access denied.';
      response.errors = ['Missing X-Requested-With header. Must be set to "XMLHttpRequest" or "app" to avoid request forgery.'];
      res.status(400);
      res.type('json');
      res.send(JSON.stringify(response, null, 2));
    } else {
      // Allow external access to all read methods
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method))
        res.set('Access-Control-Allow-Origin', '*');

      return next();
    }
  },
  signinRequired(req, res) {
    let response = {};
    response.message = 'Could not perform action.';
    response.errors = ['Authentication required.'];
    res.type('json');
    res.status(401);
    res.send(JSON.stringify(response, null, 2));
  },
  // Send one or multiple errors. Can be array of strings, or single string.
  // Error status is 400 (bad request) if not specified
  error(req, res, errors, status = 400) {
    if (!Array.isArray(errors))
      errors = errors === undefined ? ['Unspecified error.'] : [errors];
    res.type('json');
    res.status(status);
    res.send({
      message: 'Could not perform action.',
      errors
    });
  }
};

export default api;
