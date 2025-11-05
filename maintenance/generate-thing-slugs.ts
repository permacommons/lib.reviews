// Generate/update human-readable identifier strings ('slugs') for all 'things'
// (review subjects) in the database.

import { initializeDAL } from '../bootstrap/dal.ts';
import Thing from '../models/thing.js';

type SluggableThing = {
  label?: unknown;
  updateSlug(userID: string | undefined, language?: string): Promise<SluggableThing>;
  save(): Promise<unknown>;
};

async function generateSlugs(): Promise<void> {
  await initializeDAL();
  const things = (await Thing.filter({ _oldRevOf: false }, { default: true })
    .filter({ _revDeleted: false }, { default: true })
    .run()) as SluggableThing[];

  const updates: Array<Promise<SluggableThing>> = [];
  for (const thing of things) {
    if (!thing.label) {
      continue;
    }
    // Legacy maintenance tasks run without a user context; propagate the historical behaviour.
    updates.push(thing.updateSlug(undefined, 'en'));
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
