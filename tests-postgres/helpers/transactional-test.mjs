'use strict';

import asyncLocalStorage from '../../dal/lib/async-context.js';

export const transactionalTest = test => async (t, ...args) => {
  const { dalFixture } = t.context;
  if (!dalFixture.isConnected()) {
    return test(t, ...args);
  }

  const client = await dalFixture.dal.pool.connect();
  try {
    await client.query('BEGIN');
    return await asyncLocalStorage.run({ client }, () => test(t, ...args));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
};
