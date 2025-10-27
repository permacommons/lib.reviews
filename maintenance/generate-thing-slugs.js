// Generate/update human-readable identifier strings ('slugs') for all 'things'
// (review subjects) in the database.
'use strict';

const { initializeDAL } = require('../bootstrap/dal');
const Thing = require('../models/thing');

async function generateSlugs() {
  await initializeDAL();

  const things = await Thing
    .filter({ _oldRevOf: false }, { default: true })
    .filter({ _revDeleted: false }, { default: true })
    .run();

  const updates = [];
  for (const thing of things) {
    if (!thing.label) {
      continue;
    }
    updates.push(thing.updateSlug(undefined, 'en'));
  }

  const updated = await Promise.all(updates);
  await Promise.all(updated.map(thing => thing.save()));

  console.log('Operation completed - all thing records now have associated slugs.');
}

generateSlugs()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Failed to generate Thing slugs:', error);
    process.exit(1);
  });
