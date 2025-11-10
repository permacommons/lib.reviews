import type { ThingInstance, ThingModel } from '../../models/manifests/thing.ts';

export type MultilingualString = Record<string, string>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clonePlainObject<T extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown
): T {
  return (isPlainObject(value) ? { ...value } : {}) as T;
}

export function isMultilingualString(value: unknown): value is MultilingualString {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every(entry => typeof entry === 'string');
}

export type SyncDescriptionConfig = {
  active?: boolean;
  source?: string;
  updated?: unknown;
};

export type ThingSyncConfiguration = {
  description?: SyncDescriptionConfig;
};

export function hasSyncDescription(
  value: unknown
): value is ThingSyncConfiguration & { description: SyncDescriptionConfig } {
  if (!isPlainObject(value)) {
    return false;
  }

  const { description } = value;
  if (!isPlainObject(description)) {
    return false;
  }

  const { active, source } = description;
  if (active !== undefined && typeof active !== 'boolean') {
    return false;
  }

  if (source !== undefined && typeof source !== 'string') {
    return false;
  }

  return true;
}

export function isThingInstance(value: unknown, ctor: ThingModel): value is ThingInstance {
  return typeof ctor === 'function' && value instanceof ctor;
}
