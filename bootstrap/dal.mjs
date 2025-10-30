/**
 * ESM bridge for the DAL bootstrap.
 *
 * Provides a forward-compatible `.mjs` entry so ESM modules can import the
 * existing CommonJS implementation without waiting for a full conversion.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dalBootstrap = require('./dal.js');

export const {
  initializeDAL,
  getDAL,
  getModel,
  getAllModels,
  isInitialized,
  shutdown,
  registerAllModels,
  createTestHarness
} = dalBootstrap;

export default dalBootstrap;
