import config from 'config';

import { initializeDAL } from '../bootstrap/dal.ts';
import AccountRequest from '../models/account-request.ts';
import debug from '../util/debug.ts';

debug.util.enabled = true;
debug.errorLog.enabled = true;

const RETENTION_DAYS =
  (config.has('accountRequests.retentionDays')
    ? config.get<number>('accountRequests.retentionDays')
    : undefined) ?? 90;

async function cleanupAccountRequests(): Promise<void> {
  await initializeDAL();

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const deleted = await AccountRequest.filterWhere({
    status: AccountRequest.ops.neq('pending'),
    createdAt: AccountRequest.ops.lt(cutoff),
  }).delete();

  debug.util(
    `Account request cleanup: deleted ${deleted} approved/rejected requests created before ${cutoff.toISOString()} (retention ${RETENTION_DAYS} days)`
  );
}

cleanupAccountRequests()
  .then(() => process.exit(0))
  .catch(error => {
    debug.error('Problem cleaning up account requests:', error);
    process.exit(1);
  });
