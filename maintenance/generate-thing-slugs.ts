// Generate/update human-readable identifier strings ('slugs') for all 'things'
// (review subjects) in the database.

import { initializeDAL } from '../bootstrap/dal.ts';
import type { ThingInstance } from '../models/manifests/thing.ts';
import Thing from '../models/thing.js';

async function generateSlugs(): Promise<void> {
  await initializeDAL();
  const things = (await Thing.filterWhere({}).run()) as ThingInstance[];

  const updates: Array<Promise<ThingInstance>> = [];
  for (const thing of things) {
    if (!thing.label) {
      continue;
    }
    // Maintenance tasks run without a user context.
    updates.push(thing.updateSlug(undefined, thing.originalLanguage || 'und'));
  }

  const updated = await Promise.all(updates);
  await Promise.all(updated.map(thing => thing.save()));

  console.log('Operation completed - all thing records now have associated slugs.');
}

generateSlugs()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Failed to generate Thing slugs:', error);
    process.exit(1);
  });
