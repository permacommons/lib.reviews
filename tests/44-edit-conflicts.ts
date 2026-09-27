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

// Current path of a form, following slug redirects as a browser would
const resolvePath = async (agent, path: string): Promise<string> => {
  const response = await agent.get(path).redirects(5).expect(200);
  const lastRedirect = response.redirects.at(-1);
  return lastRedirect ? new URL(lastRedirect).pathname : path;
};

// Open a form in a second tab as the same user and submit it, as if the user
// saved another copy of the form while the first one was still open
const saveInSecondTab = async (agent, path: string, fields: Record<string, unknown>) => {
  const formPath = await resolvePath(agent, path);
  const formResponse = await agent.get(formPath).expect(200);
  const revTeams = extractRevTeams(formResponse.text);
  const response = await agent
    .post(formPath)
    .type('form')
    .send({
      _csrf: extractCSRF(formResponse.text),
      'rev-id': extractRevID(formResponse.text) ?? undefined,
      ...(revTeams === null ? {} : { 'rev-teams': revTeams }),
      ...fields,
    });
  if (response.status >= 400 || CONFLICT_NOTICE.test(response.text))
    throw new Error(`Second tab could not save ${formPath}: ${response.status}`);
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
  // A concurrent edit of the same field and language, made in a second tab.
  // Fields are merged into the submission.
  otherEditSameField: { fields: Record<string, unknown>; value: unknown };
  // A concurrent edit that the user's form does not touch. With a path, the
  // fields are submitted to that form instead of being merged.
  otherEditElsewhere: {
    path?: (id: string) => string;
    fields: Record<string, unknown>;
    read(doc): unknown;
    value: unknown;
  };
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
      fields: { 'review-title': 'Their title' },
      value: 'Their title',
    },
    otherEditElsewhere: {
      fields: {
        'review-title': 'Ihr Titel',
        'review-text': 'Ihr Text',
        'review-language': 'de',
      },
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
      fields: { 'thing-label': 'Their label' },
      value: 'Their label',
    },
    otherEditElsewhere: {
      fields: { 'thing-label': 'Ihr Name', 'thing-language': 'de' },
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
      fields: { 'thing-description': 'Their description' },
      value: 'Their description',
    },
    otherEditElsewhere: {
      fields: { 'thing-description': 'Ihre Beschreibung', 'thing-language': 'de' },
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
      fields: { 'urls[]': ['https://example.org/their-link'] },
      value: 'https://example.org/their-link',
    },
    otherEditElsewhere: {
      path: id => `/${id}/edit/label`,
      fields: { 'thing-label': 'Their label', 'thing-language': 'en' },
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
      fields: { 'team-motto': 'Their motto' },
      value: 'Their motto',
    },
    otherEditElsewhere: {
      fields: {
        'team-name': 'Ihr Team',
        'team-motto': 'Ihr Motto',
        'team-description': 'Ihre Beschreibung',
        'team-rules': 'Ihre Regeln',
        'team-language': 'de',
      },
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
      fields: { 'post-title': 'Their post title' },
      value: 'Their post title',
    },
    otherEditElsewhere: {
      fields: {
        'post-title': 'Ihr Beitragstitel',
        'post-text': 'Ihr Beitragstext',
        'post-language': 'de',
      },
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
      fields: { 'bio-text': 'Their bio' },
      value: 'Their bio',
    },
    otherEditElsewhere: {
      fields: { 'bio-text': 'Ihre Biografie', 'bio-language': 'de' },
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
  // Saves that rename a thing or team change its slug, and a form posted to
  // the old slug is redirected before it is processed. This posts to the
  // current path so the conflict check is what gets tested.
  const submit = async (fields: Record<string, unknown>) =>
    agent
      .post(await resolvePath(agent, editURL))
      .type('form')
      .send({ _csrf: csrf, ...hiddenFields, ...formCase.submission, ...fields });

  // Save a competing edit in a second tab and return the new revision ID
  const saveOtherEdit = async (edit: 'sameField' | 'elsewhere'): Promise<string> => {
    if (edit === 'sameField')
      await saveInSecondTab(agent, editURL, {
        ...formCase.submission,
        ...formCase.otherEditSameField.fields,
      });
    else {
      const { path, fields } = formCase.otherEditElsewhere;
      await saveInSecondTab(
        agent,
        path ? path(id) : editURL,
        path ? fields : { ...formCase.submission, ...fields }
      );
    }
    return (await Model.get(id))._revID;
  };
  return { Model, id, revID, submit, saveOtherEdit, user, agent };
};

for (const formCase of editFormCases) {
  test.serial(
    `${formCase.name}: stale revision ID with a conflicting edit is rejected`,
    async t => {
      const { Model, id, revID, submit, saveOtherEdit } = await openEditForm(formCase);
      const theirRevID = await saveOtherEdit('sameField');

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
    const { Model, id, revID, submit, saveOtherEdit } = await openEditForm(formCase);
    await saveOtherEdit('elsewhere');

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
    const { Model, id, submit, saveOtherEdit } = await openEditForm(formCase);
    await saveOtherEdit('sameField');

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
  const { revID, submit, saveOtherEdit } = await openEditForm(reviewCase);
  await saveOtherEdit('sameField');

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
  const { Model, id, revID, submit, saveOtherEdit } = await openEditForm(reviewCase);
  await saveOtherEdit('sameField');

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
  const { revID, submit, saveOtherEdit } = await openEditForm(thingDescriptionCase);
  await saveOtherEdit('sameField');

  const response = await submit({ 'rev-id': revID, 'thing-description': '' });

  t.is(response.status, 409);
  t.regex(response.text, /id="thing-edit-description" name="thing-description" value=""/);
});

const openReviewFormWithTeam = async () => {
  const form = await openEditForm(reviewCase);
  await createTeamViaForm(form.agent);
  const team = await Team.filterWhere({ createdBy: form.user.id }).first();
  // Select the team in a second tab, leaving the review's text unchanged
  const saveTeamSelection = async (): Promise<string> => {
    await saveInSecondTab(form.agent, `/review/${form.id}/edit`, {
      ...reviewCase.submission,
      'review-title': 'Original title',
      'review-text': 'Original text',
      'teams[]': team.id,
    });
    return (await Review.get(form.id))._revID;
  };
  return { ...form, team, saveTeamSelection };
};

test.serial('review: a concurrent change of teams alone is a conflict', async t => {
  const { id, revID, submit, team, saveTeamSelection } = await openReviewFormWithTeam();
  const theirRevID = await saveTeamSelection();

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
  const { id, revID, submit, saveTeamSelection } = await openReviewFormWithTeam();
  await saveTeamSelection();

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
