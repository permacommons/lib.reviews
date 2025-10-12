export const extractCSRF = html => {
  let matches = html.match(/<input type="hidden" value="(.*?)" name="_csrf">/);
  return matches && matches[1] ? matches[1] : null;
};

/**
 * Register a user through the standard form, handling CSRF extraction and
 * optional redirect follow-up.
 *
 * @param {import('supertest').SuperAgentTest} agent
 *  SuperTest agent instance to maintain cookies/session state.
 * @param {Object} options
 * @param {String} options.username
 *  Desired display name for the new user.
 * @param {String} [options.password='testing123']
 *  Password to submit during registration.
 * @param {String|null} [options.expectedLocation='/']
 *  Location header expected after successful registration. Set to null to skip the check.
 * @param {Boolean} [options.followRedirect=true]
 *  Whether to perform a GET request to the redirect target. When true, the helper
 *  asserts a 200 response and returns it as `landingResponse`.
 * @returns {Promise<{registerResponse: import('superagent').Response, postResponse: import('superagent').Response, landingResponse?: import('superagent').Response}>}
 *  The responses gathered during registration.
 */
export const registerTestUser = async(agent, {
  username,
  password = 'testing123',
  expectedLocation = '/',
  followRedirect = true
} = {}) => {
  if (!username)
    throw new Error('Username is required to register a test user.');

  const registerResponse = await agent.get('/register');
  const csrf = extractCSRF(registerResponse.text);
  if (!csrf)
    throw new Error('Could not obtain CSRF token during test user registration.');

  const postResponse = await agent
    .post('/register')
    .type('form')
    .send({
      _csrf: csrf,
      username,
      password
    })
    .expect(302);

  if (expectedLocation && postResponse.headers.location !== expectedLocation)
    throw new Error(`Unexpected redirect location: ${postResponse.headers.location}`);

  let landingResponse;
  if (followRedirect && postResponse.headers.location)
    landingResponse = await agent
      .get(postResponse.headers.location)
      .expect(200);

  return { registerResponse, postResponse, landingResponse };
};
