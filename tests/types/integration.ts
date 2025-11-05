import type { ExecutionContext } from 'ava';
import type { Express } from 'express';
import type { SuperAgentTest } from 'supertest';

/**
 * Agent union compatible with current @types/supertest output from supertest.agent(app),
 * and with optional close() used in some tests for cleanup.
 */
type SupertestModule = typeof import('supertest');
export type AgentLike = SuperAgentTest | ReturnType<SupertestModule['agent']>;
export type AgentWithOptionalClose = AgentLike & { close?: (cb: (err?: unknown) => void) => void };

/**
 * Shared context type for integration tests that use Express app + supertest agent.
 */
export interface IntegrationTestContext {
  app: Express | null;
  agent: AgentWithOptionalClose | null;
}

/**
 * Helper to safely extract app and agent from test context, throwing if not initialized.
 */
export const requireIntegrationContext = (t: ExecutionContext<IntegrationTestContext>) => {
  const { app, agent } = t.context;
  if (!app || !agent) throw new Error('Integration context not initialized');
  return { app, agent };
};
