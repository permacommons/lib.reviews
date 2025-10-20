import { randomUUID } from 'crypto';

/**
 * Create or reuse a user via the PostgreSQL model.
 * Ensures foreign key constraints (created_by, _rev_user) remain satisfied.
 * @param {Object} dalFixture - Active DAL fixture with initialized models
 * @param {Object} [options]
 * @param {string} [options.namePrefix='Test User'] - prefix for generated name/email
 * @returns {Promise<{model: *, actor: {id: string, is_super_user: boolean, is_trusted: boolean}}>} user info and actor payload
 */
export async function createTestUser(dalFixture, { namePrefix = 'Test User' } = {}) {
  if (!dalFixture?.User) {
    throw new Error('User model not initialized on DAL fixture');
  }

  const uuid = randomUUID();
  const name = `${namePrefix} ${uuid.slice(0, 8)}`;

  const user = await dalFixture.User.create({
    name,
    password: 'secret123',
    email: `${uuid}@example.com`
  });

  return {
    model: user,
    actor: {
      id: user.id,
      is_super_user: false,
      is_trusted: true
    }
  };
}

export default createTestUser;
