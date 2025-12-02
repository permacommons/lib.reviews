// Deletes password reset tokens older than the configured retention window.
import { initializeDAL } from '../bootstrap/dal.ts';
import PasswordResetToken from '../models/password-reset-token.ts';
import debug from '../util/debug.ts';

const RETENTION_DAYS = 7;

// Commonly run from command-line, force output
debug.util.enabled = true;
debug.errorLog.enabled = true;

async function cleanupPasswordResetTokens(): Promise<void> {
  await initializeDAL();

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await PasswordResetToken.filterWhere({
    createdAt: PasswordResetToken.ops.lt(cutoff),
  }).delete();

  debug.util(
    `Password reset token cleanup: deleted ${deleted} tokens created before ${cutoff.toISOString()} (retention ${RETENTION_DAYS} days)`
  );
}

cleanupPasswordResetTokens()
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    debug.error('Problem cleaning up password reset tokens:', error);
    process.exit(1);
  });
