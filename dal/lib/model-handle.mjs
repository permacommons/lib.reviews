import modelHandleModule from './model-handle.js';

export const {
  setBootstrapResolver,
  createModelModule,
  createAutoModelHandle,
  createLazyHandleExport,
  registerLazyHandle
} = modelHandleModule ?? {};

export default modelHandleModule;
