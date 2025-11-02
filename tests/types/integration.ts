import type { Express } from 'express';
import type { SuperAgentTest } from 'supertest';
import type { ExecutionContext } from 'ava';

/**
 * Shared context type for integration tests that use Express app + supertest agent.
 */
export interface IntegrationTestContext {
  app: Express | null;
  agent: SuperAgentTest | null;
}

/**
 * Helper to safely extract app and agent from test context, throwing if not initialized.
 */
export const requireIntegrationContext = (t: ExecutionContext<IntegrationTestContext>) => {
  const { app, agent } = t.context;
  if (!app || !agent)
    throw new Error('Integration context not initialized');
  return { app, agent };
};
