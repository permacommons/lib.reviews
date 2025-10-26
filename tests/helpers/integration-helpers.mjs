export const extractCSRF = html => {
  const matches = html.match(/<input type="hidden" value="(.*?)" name="_csrf">/);
  return matches && matches[1] ? matches[1] : null;
};

/**
 * Register a test user through the standard form.
 *
 * @param {import('supertest').SuperAgentTest} agent - Maintains session state.
 * @param {Object} options
 * @param {string} options.username - Display name for the new user.
 * @param {string} [options.password='testing123'] - Password to submit.
 * @param {string|null} [options.expectedLocation='/'] - Expected redirect target; null to skip.
 * @param {boolean} [options.followRedirect=true] - Whether to fetch the redirect destination.
 * @returns {Promise<{registerResponse: import('superagent').Response, postResponse: import('superagent').Response, landingResponse?: import('superagent').Response}>}
 */
export const registerTestUser = async (
  agent,
  {
    username,
    password = 'testing123',
    expectedLocation = '/',
    followRedirect = true
  } = {}
) => {
  if (!username) throw new Error('Username is required to register a test user.');

  const registerResponse = await agent.get('/register');
  const csrf = extractCSRF(registerResponse.text);
  if (!csrf) throw new Error('Could not obtain CSRF token during test user registration.');

  const postResponse = await agent
    .post('/register')
    .type('form')
    .send({
      _csrf: csrf,
      username,
      password
    })
    .expect(302);

  if (expectedLocation && postResponse.headers.location !== expectedLocation) {
    throw new Error(`Unexpected redirect location: ${postResponse.headers.location}`);
  }

  let landingResponse;
  if (followRedirect && postResponse.headers.location) {
    landingResponse = await agent.get(postResponse.headers.location).expect(200);
  }

  return { registerResponse, postResponse, landingResponse };
};
