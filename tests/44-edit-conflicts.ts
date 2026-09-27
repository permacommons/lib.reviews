import { randomUUID } from 'node:crypto';
import test from 'ava';
import config from 'config';
import { promises as fs } from 'fs';
import supertest from 'supertest';
import { extractCSRF, registerTestUser } from './helpers/integration-helpers.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const loadAppModule = () => import('../app.ts');

mockSearch();

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'edit_conflicts',
  cleanupTables: [
    'review_teams',
    'team_moderators',
    'team_members',
    'blog_posts',
    'reviews',
    'teams',
    'things',
    'users',
    'user_metas',
  ],
});

let User, Thing, Review, Team, BlogPost, UserMeta;
let app;

test.before(async () => {
  await bootstrapPromise;

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' },
    { key: 'teams', alias: 'Team' },
    { key: 'blog_posts', alias: 'BlogPost' },
    { key: 'user_metas', alias: 'UserMeta' },
  ]);
  ({ User, Thing, Review, Team, BlogPost, UserMeta } = models);

  await fs.mkdir(config.uploadTempDir, { recursive: true });

  const { default: getApp, resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function') await resetAppForTesting();
  app = await getApp();
});

const CONFLICT_NOTICE = /Someone else changed this while you were editing it/;

const extractRevID = (html: string): string | null => {
  const match = html.match(/<input type="hidden" value="([^"]*)" name="rev-id"/);
  return match ? match[1] : null;
};

const extractRevTeams = (html: string): string | null => {
  const match = html.match(/<input type="hidden" value="([^"]*)" name="rev-teams"/);
  return match ? match[1] : null;
};

const signInTrustedUser = async () => {
  const agent = supertest.agent(app);
  const username = `Editor-${randomUUID().slice(0, 8)}`;
  await registerTestUser(agent, { username, password: 'password123' });
  const user = await User.findByURLName(username);
  user.isTrusted = true;
  await user.save();
  return { agent, user };
};

// Save a newer revision as someone else, as if they edited the document
// while the form was open
const saveOtherRevision = async (Model, id: string, change: (doc) => void): Promise<string> => {
  const { actor } = await dalFixture.createTestUser('Other Editor');
  const doc = await Model.get(id);
  await doc.newRevision(actor, { tags: ['test-other-edit'] });
  change(doc);
  await doc.save();
  return doc._revID;
};

const createThing = async (label: string) => {
  const { actor } = await dalFixture.createTestUser('Thing Creator');
  const thing = await Thing.createFirstRevision(actor, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: label };
  thing.metadata = { description: { en: 'Original description' } };
  thing.originalLanguage = 'en';
  thing.createdOn = new Date();
  thing.createdBy = actor.id;
  await thing.save();
  return thing;
};

const createTeamViaForm = async agent => {
  const newTeamResponse = await agent.get('/new/team').expect(200);
  const response = await agent
    .post('/new/team')
    .type('form')
    .send({
      _csrf: extractCSRF(newTeamResponse.text),
      'team-name': `Team ${randomUUID().slice(0, 8)}`,
      'team-motto': 'Original motto',
      'team-description': 'Original description',
      'team-rules': 'Original rules',
      'team-language': 'en',
      'team-action': 'publish',
    })
    .expect(302);
  return response.headers.location as string;
};

interface EditFormCase {
  name: string;
  successStatus: number;
  // Creates the document and returns its model, ID and edit form URL
  setup(agent, user): Promise<{ Model; id: string; editURL: string }>;
  // Fields submitted by the user, who edits in English
  submission: Record<string, unknown>;
  // Matches the user's submission when the form is shown again
  submissionPattern: RegExp;
  // Value the user's edit sets, read from the stored document
  readEditedValue(doc): unknown;
  userValue: unknown;
  // A concurrent edit of the same field and language
  otherEditSameField: { apply(doc): void; value: unknown };
  // A concurrent edit that the user's form does not touch
  otherEditElsewhere: { apply(doc): void; read(doc): unknown; value: unknown };
}

const editFormCases: EditFormCase[] = [
  {
    name: 'review',
    successStatus: 302,
    async setup(agent) {
      const newReviewResponse = await agent.get('/new/review').expect(200);
      const postResponse = await agent
        .post('/new/review')
        .type('form')
        .send({
          _csrf: extractCSRF(newReviewResponse.text),
          'review-url': `https://example.com/${randomUUID()}`,
          'review-title': 'Original title',
          'review-text': 'Original text',
          'review-rating': '3',
          'review-language': 'en',
          'review-action': 'publish',
        })
        .expect(302);
      const thingResponse = await agent.get(postResponse.headers.location).expect(200);
      const match = thingResponse.text.match(/<a href="\/review\/(.*?)\/edit"/);
      if (!match) throw new Error('Could not find review edit link');
      return { Model: Review, id: match[1], editURL: `/review/${match[1]}/edit` };
    },
    submission: {
      'review-title': 'My edited title',
      'review-text': 'My edited text',
      'review-rating': '3',
      'review-language': 'en',
      'review-action': 'publish',
    },
    submissionPattern: /value="My edited title"/,
    readEditedValue: doc => doc.title.en,
    userValue: 'My edited title',
    otherEditSameField: {
      apply: doc => (doc.title = { ...doc.title, en: 'Their title' }),
      value: 'Their title',
    },
    otherEditElsewhere: {
      apply: doc => (doc.title = { ...doc.title, de: 'Ihr Titel' }),
      read: doc => doc.title.de,
      value: 'Ihr Titel',
    },
  },
  {
    name: 'thing label',
    successStatus: 302,
    async setup() {
      const thing = await createThing('Original label');
      return { Model: Thing, id: thing.id, editURL: `/${thing.id}/edit/label` };
    },
    submission: { 'thing-label': 'My label', 'thing-language': 'en' },
    submissionPattern: /value="My label"/,
    readEditedValue: doc => doc.label.en,
    userValue: 'My label',
    otherEditSameField: {
      apply: doc => (doc.label = { ...doc.label, en: 'Their label' }),
      value: 'Their label',
    },
    otherEditElsewhere: {
      apply: doc => (doc.label = { ...doc.label, de: 'Ihr Name' }),
      read: doc => doc.label.de,
      value: 'Ihr Name',
    },
  },
  {
    name: 'thing description',
    successStatus: 302,
    async setup() {
      const thing = await createThing('Thing with description');
      return { Model: Thing, id: thing.id, editURL: `/${thing.id}/edit/description` };
    },
    submission: { 'thing-description': 'My description', 'thing-language': 'en' },
    submissionPattern: /value="My description"/,
    readEditedValue: doc => doc.metadata.description.en,
    userValue: 'My description',
    otherEditSameField: {
      apply: doc =>
        (doc.metadata = {
          ...doc.metadata,
          description: { ...doc.metadata.description, en: 'Their description' },
        }),
      value: 'Their description',
    },
    otherEditElsewhere: {
      apply: doc =>
        (doc.metadata = {
          ...doc.metadata,
          description: { ...doc.metadata.description, de: 'Ihre Beschreibung' },
        }),
      read: doc => doc.metadata.description.de,
      value: 'Ihre Beschreibung',
    },
  },
  {
    // Links are not language-specific, so the unrelated edit changes the label
    name: 'thing URLs',
    successStatus: 200,
    async setup() {
      const thing = await createThing('Thing with links');
      return { Model: Thing, id: thing.id, editURL: `/${thing.id}/manage/urls` };
    },
    submission: { primary: '0', 'urls[]': ['https://example.org/my-link'] },
    submissionPattern: /value="https:\/\/example\.org\/my-link"/,
    readEditedValue: doc => doc.urls[0],
    userValue: 'https://example.org/my-link',
    otherEditSameField: {
      apply: doc => (doc.urls = ['https://example.org/their-link']),
      value: 'https://example.org/their-link',
    },
    otherEditElsewhere: {
      apply: doc => (doc.label = { ...doc.label, en: 'Their label' }),
      read: doc => doc.label.en,
      value: 'Their label',
    },
  },
  {
    name: 'team',
    successStatus: 302,
    async setup(agent, user) {
      const teamURL = await createTeamViaForm(agent);
      const team = await Team.filterWhere({ createdBy: user.id }).first();
      return { Model: Team, id: team.id, editURL: `${teamURL}/edit` };
    },
    submission: {
      'team-name': 'My team name',
      'team-motto': 'My motto',
      'team-description': 'My description',
      'team-rules': 'My rules',
      'team-language': 'en',
      'team-action': 'publish',
    },
    submissionPattern: /value="My motto"/,
    readEditedValue: doc => doc.motto.en,
    userValue: 'My motto',
    otherEditSameField: {
      apply: doc => (doc.motto = { ...doc.motto, en: 'Their motto' }),
      value: 'Their motto',
    },
    otherEditElsewhere: {
      apply: doc => (doc.motto = { ...doc.motto, de: 'Ihr Motto' }),
      read: doc => doc.motto.de,
      value: 'Ihr Motto',
    },
  },
  {
    name: 'blog post',
    successStatus: 302,
    async setup(agent) {
      const teamURL = await createTeamViaForm(agent);
      const newPostResponse = await agent.get(`${teamURL}/new/post`).expect(200);
      const postResponse = await agent
        .post(`${teamURL}/new/post`)
        .type('form')
        .send({
          _csrf: extractCSRF(newPostResponse.text),
          'post-title': 'Original post title',
          'post-text': 'Original post text',
          'post-language': 'en',
          'post-action': 'publish',
        })
        .expect(302);
      const postURL = postResponse.headers.location as string;
      const id = postURL.split('/').pop() as string;
      return { Model: BlogPost, id, editURL: `${postURL}/edit` };
    },
    submission: {
      'post-title': 'My post title',
      'post-text': 'My post text',
      'post-language': 'en',
      'post-action': 'publish',
    },
    submissionPattern: /value="My post title"/,
    readEditedValue: doc => doc.title.en,
    userValue: 'My post title',
    otherEditSameField: {
      apply: doc => (doc.title = { ...doc.title, en: 'Their post title' }),
      value: 'Their post title',
    },
    otherEditElsewhere: {
      apply: doc => (doc.title = { ...doc.title, de: 'Ihr Beitragstitel' }),
      read: doc => doc.title.de,
      value: 'Ihr Beitragstitel',
    },
  },
  {
    name: 'user bio',
    successStatus: 302,
    async setup(agent, user) {
      const editURL = `/user/${user.urlName}/edit/bio`;
      const bioFormResponse = await agent.get(editURL).expect(200);
      await agent
        .post(editURL)
        .type('form')
        .send({
          _csrf: extractCSRF(bioFormResponse.text),
          'bio-text': 'Original bio',
          'bio-language': 'en',
        })
        .expect(302);
      const userWithMeta = await User.findByURLName(user.urlName, { withData: true });
      return { Model: UserMeta, id: userWithMeta.meta.id, editURL };
    },
    submission: { 'bio-text': 'My bio', 'bio-language': 'en' },
    submissionPattern: />My bio<\/textarea>/,
    readEditedValue: doc => doc.bio.text.en,
    userValue: 'My bio',
    otherEditSameField: {
      apply: doc =>
        (doc.bio = {
          text: { ...doc.bio.text, en: 'Their bio' },
          html: { ...doc.bio.html, en: '<p>Their bio</p>' },
        }),
      value: 'Their bio',
    },
    otherEditElsewhere: {
      apply: doc =>
        (doc.bio = {
          text: { ...doc.bio.text, de: 'Ihre Biografie' },
          html: { ...doc.bio.html, de: '<p>Ihre Biografie</p>' },
        }),
      read: doc => doc.bio.text.de,
      value: 'Ihre Biografie',
    },
  },
];

// Open the edit form and return what a browser would submit with it
const openEditForm = async (formCase: EditFormCase) => {
  const { agent, user } = await signInTrustedUser();
  const { Model, id, editURL } = await formCase.setup(agent, user);
  const formResponse = await agent.get(editURL).expect(200);
  const revID = extractRevID(formResponse.text);
  if (!revID) throw new Error(`No revision ID on the ${formCase.name} form`);
  const csrf = extractCSRF(formResponse.text);
  if (!csrf) throw new Error(`No CSRF token on the ${formCase.name} form`);
  const revTeams = extractRevTeams(formResponse.text);
  const hiddenFields = revTeams === null ? {} : { 'rev-teams': revTeams };
  const submit = (fields: Record<string, unknown>) =>
    agent
      .post(editURL)
      .type('form')
      .send({ _csrf: csrf, ...hiddenFields, ...formCase.submission, ...fields });
  return { Model, id, revID, submit, user, agent };
};

for (const formCase of editFormCases) {
  test.serial(
    `${formCase.name}: stale revision ID with a conflicting edit is rejected`,
    async t => {
      const { Model, id, revID, submit } = await openEditForm(formCase);
      const theirRevID = await saveOtherRevision(Model, id, formCase.otherEditSameField.apply);

      const response = await submit({ 'rev-id': revID });

      t.is(response.status, 409);
      t.regex(response.text, CONFLICT_NOTICE);
      t.regex(response.text, formCase.submissionPattern, "user's input is preserved");
      t.is(extractRevID(response.text), theirRevID, 'form is now based on the current revision');
      const stored = await Model.get(id);
      t.is(formCase.readEditedValue(stored), formCase.otherEditSameField.value);
      t.is(stored._revID, theirRevID, 'nothing was saved');
    }
  );

  test.serial(`${formCase.name}: stale revision ID with an unrelated edit saves`, async t => {
    const { Model, id, revID, submit } = await openEditForm(formCase);
    await saveOtherRevision(Model, id, formCase.otherEditElsewhere.apply);

    const response = await submit({ 'rev-id': revID });

    t.is(response.status, formCase.successStatus);
    t.notRegex(response.text, CONFLICT_NOTICE);
    const stored = await Model.get(id);
    t.deepEqual(formCase.readEditedValue(stored), formCase.userValue);
    t.is(formCase.otherEditElsewhere.read(stored), formCase.otherEditElsewhere.value);
  });

  test.serial(`${formCase.name}: current revision ID saves`, async t => {
    const { Model, id, revID, submit } = await openEditForm(formCase);

    const response = await submit({ 'rev-id': revID });

    t.is(response.status, formCase.successStatus);
    const stored = await Model.get(id);
    t.deepEqual(formCase.readEditedValue(stored), formCase.userValue);
  });

  test.serial(`${formCase.name}: missing revision ID saves as before`, async t => {
    const { Model, id, submit } = await openEditForm(formCase);
    await saveOtherRevision(Model, id, formCase.otherEditSameField.apply);

    const response = await submit({});

    t.is(response.status, formCase.successStatus);
    const stored = await Model.get(id);
    t.deepEqual(formCase.readEditedValue(stored), formCase.userValue);
  });
}

const [reviewCase] = editFormCases;

test.serial('review: unknown or malformed revision IDs are treated as conflicts', async t => {
  const { Model, id, submit } = await openEditForm(reviewCase);

  for (const revID of [randomUUID(), 'not-a-revision']) {
    const response = await submit({ 'rev-id': revID });
    t.is(response.status, 409, revID);
    t.regex(response.text, CONFLICT_NOTICE);
  }
  const stored = await Model.get(id);
  t.is(stored.title.en, 'Original title');
});

test.serial('review: preview and validation errors keep the submitted revision ID', async t => {
  const { Model, id, revID, submit } = await openEditForm(reviewCase);
  await saveOtherRevision(Model, id, reviewCase.otherEditSameField.apply);

  const previewResponse = await submit({ 'rev-id': revID, 'review-action': 'preview' });
  t.is(previewResponse.status, 200);
  t.is(extractRevID(previewResponse.text), revID);

  const invalidResponse = await submit({ 'rev-id': revID, 'review-title': '' });
  t.is(invalidResponse.status, 200);
  t.is(extractRevID(invalidResponse.text), revID);

  // Resubmitting from either form still detects the conflict
  const response = await submit({ 'rev-id': extractRevID(invalidResponse.text) });
  t.is(response.status, 409);
});

test.serial('review: resubmitting after a conflict saves', async t => {
  const { Model, id, revID, submit } = await openEditForm(reviewCase);
  await saveOtherRevision(Model, id, reviewCase.otherEditSameField.apply);

  const conflictResponse = await submit({ 'rev-id': revID });
  t.is(conflictResponse.status, 409);

  const response = await submit({ 'rev-id': extractRevID(conflictResponse.text) });
  t.is(response.status, 302);
  const stored = await Model.get(id);
  t.is(stored.title.en, reviewCase.userValue);
});

const thingDescriptionCase = editFormCases.find(
  formCase => formCase.name === 'thing description'
) as EditFormCase;

test.serial('thing description: clearing the field is preserved on conflict', async t => {
  const { Model, id, revID, submit } = await openEditForm(thingDescriptionCase);
  await saveOtherRevision(Model, id, thingDescriptionCase.otherEditSameField.apply);

  const response = await submit({ 'rev-id': revID, 'thing-description': '' });

  t.is(response.status, 409);
  t.regex(response.text, /id="thing-edit-description" name="thing-description" value=""/);
});

// Associate the review with a team as someone else, in a new revision
const saveOtherTeamSelection = async (id: string, teams): Promise<string> => {
  const { actor } = await dalFixture.createTestUser('Other Editor');
  const review = await Review.get(id);
  await review.newRevision(actor, { tags: ['test-other-edit'] });
  review.teams = teams;
  await review.saveAll({ teams: true });
  return review._revID;
};

const openReviewFormWithTeam = async () => {
  const form = await openEditForm(reviewCase);
  await createTeamViaForm(form.agent);
  const team = await Team.filterWhere({ createdBy: form.user.id }).first();
  return { ...form, team };
};

test.serial('review: a concurrent change of teams alone is a conflict', async t => {
  const { id, revID, submit, team } = await openReviewFormWithTeam();
  const theirRevID = await saveOtherTeamSelection(id, [team]);

  const response = await submit({ 'rev-id': revID });

  t.is(response.status, 409);
  t.regex(response.text, CONFLICT_NOTICE);
  t.notRegex(response.text, new RegExp(`value="${team.id}" checked`), "user's selection kept");
  t.is(extractRevID(response.text), theirRevID);
  t.is(extractRevTeams(response.text), team.id);
  const stored = await Review.getWithData(id);
  t.is(stored.teams?.[0]?.id, team.id, 'team association was not removed');

  const resubmitResponse = await submit({
    'rev-id': theirRevID,
    'rev-teams': extractRevTeams(response.text),
  });
  t.is(resubmitResponse.status, 302);
  const resaved = await Review.getWithData(id);
  t.falsy(resaved.teams?.length, 'deliberate resubmission removes the team');
});

test.serial('review: team changes without a submitted team baseline save as before', async t => {
  const { id, revID, submit, team } = await openReviewFormWithTeam();
  await saveOtherTeamSelection(id, [team]);

  const response = await submit({ 'rev-id': revID, 'rev-teams': undefined });

  t.is(response.status, 302);
  const stored = await Review.getWithData(id);
  t.falsy(stored.teams?.length);
});

test.serial('review: revision ID field is saved with autosaved drafts', async t => {
  const { agent, user } = await signInTrustedUser();
  const { editURL } = await reviewCase.setup(agent, user);
  const formResponse = await agent.get(editURL).expect(200);
  const revIDInput = formResponse.text.match(/<input[^>]*name="rev-id"[^>]*>/);
  t.truthy(revIDInput);
  t.notRegex(revIDInput?.[0] ?? '', /data-ignore-autosave/);
});

test.after.always(async () => {
  unmockSearch();
  const { resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function') await resetAppForTesting();
  await dalFixture.cleanup();
});
