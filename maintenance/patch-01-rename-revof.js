// Patch for renaming the _revOf column to _oldRevOf in all revisioned tables.
// This was done for clarity, see https://github.com/permacommons/lib.reviews/issues/176

const { getDB } = require('../db');
const tables = ['blog_posts', 'files', 'reviews', 'teams', 'things', 'user_meta'];

getDB().then(async db => {
  for (let table of tables) {
    // Copy contents to new name
    await db.r.table(table).update({ _oldRevOf: db.r.row('_revOf') });
    // Delete old name
    await db.r.table(table).replace(row => row.without('_revOf'));
  }
  console.log('Update completed successfully.');
  process.exit();
})
.catch(error => {
  console.error('Error occurred during the update:');
  console.error(error.stack);
});
