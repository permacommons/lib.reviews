// Generate/update human-readable identifier strings ('slugs') for all 'things'
// (review subjects) in the database.
'use strict';
const Thing = require('../models-postgres/thing');

Thing
  .filter({
    _oldRevOf: false
  }, {
    default: true
  })
  .filter({
    _revDeleted: false
  }, {
    default: true
  })
  .then(things => {
    let p = [];
    for (let thing of things) {

      // Only update slug if we have a label we can use to derive it
      if (thing.label) {
        p.push(thing.updateSlug(undefined, 'en')); // User will be undefined
      }
    }

    Promise
      .all(p)
      // Now we still have to save the 'thing' rows
      .then(things => {
        let p = [];
        for (let thing of things)
          p.push(thing.save());

        Promise
          .all(p)
          .then(() => {
            console.log('Operation completed - all thing records now have associated slugs.');
            process.exit();
          });

      });
  });
