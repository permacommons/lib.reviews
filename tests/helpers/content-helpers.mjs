// Generator to get arbitrary number of review objects with unique URLs. Sample
// URLs are just for fun.
export function* getReviewDataGenerator(userID) {
  const urls = [
    'https://github.com/permacommons/lib.reviews/blob/master/tests/1-models.js',
    'https://github.com/permacommons/lib.reviews/blob/master/tests/2-integration-signed-out.js',
    'https://github.com/permacommons/lib.reviews/blob/master/tests/3-integration-signed-in.js',
    'https://github.com/permacommons/lib.reviews/blob/master/tests/4-adapter.js',
  ];
  for (let i = 0; true; i++) {
    yield {
      title: { en: 'A terribly designed test' },
      text: { en: 'Whoever wrote this test was clearly *drunk*, or asleep, or something.' },
      html: { en: '<p>Whoever wrote this test was clearly <em>drunk</em>, or asleep, or something.</p>' },
      url: urls[i] ||
        `https://github.com/permacommons/lib.reviews/blob/master/tests/${i + 1}-something-else.js`,
      tags: ['test_revision', 'test_revision_create'],
      createdOn: new Date(),
      createdBy: userID,
      starRating: 1,
      originalLanguage: 'en',
      // not provisioned: createdBy, revision metadata
    };
  }
}

export const getTeamData = userID => ({
  name: { en: 'Annoyed QA Team' },
  motto: { en: 'We hate it when things are broken, damnit' },
  description: {
    text: { en: 'Do *you* hate it when your software breaks? Do you write frustrated tweets to companies? Are you .. frequently .. **annoyed**? Then you might be the kind of person who should be part of this team!' },
    html: { en: '<p>Do <em>you</em> hate it when your software breaks? Do you write frustrated tweets to companies? Are you .. frequently .. <b>annoyed</b>? Then you might be the kind of person who should be part of this team!</p>' }
  },
  rules: {
    text: { en: 'You agree to exepress at least some degree of frustration on a regular basis.' },
    html: { en: '<p>You agree to exepress at least some degree of frustration on a regular basis.</p>' }
  },
  createdBy: userID,
  createdOn: new Date(),
  originalLanguage: 'en'
});
