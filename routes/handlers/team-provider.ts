import { randomUUID } from 'node:crypto';
import url from 'node:url';
import config from 'config';
import escapeHTML from 'escape-html';
import i18n from 'i18n';
import mlString, { type MultilingualString } from '../../dal/lib/ml-string.ts';
import BlogPost from '../../models/blog-post.ts';
import type { TeamInstance as TeamManifestInstance } from '../../models/manifests/team.ts';
import type { TeamJoinRequestInstance } from '../../models/manifests/team-join-request.ts';
import type { UserView } from '../../models/manifests/user.ts';
import Team from '../../models/team.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';
import debug from '../../util/debug.ts';
import frontendMessages from '../../util/frontend-messages.ts';
import feeds from '../helpers/feeds.ts';
import type { FormField } from '../helpers/forms.ts';
import slugs from '../helpers/slugs.ts';
import AbstractBREADProvider from './abstract-bread-provider.ts';

const { getEditorMessages } = frontendMessages;

type LocalizedText = MultilingualString;
type LocalizedRichText = { text: LocalizedText; html: LocalizedText };
type JoinRequestWithUser = TeamJoinRequestInstance & { user?: UserView };

type TeamInstance = TeamManifestInstance & {
  joinRequests?: JoinRequestWithUser[];
};

interface TeamFormValues {
  name?: LocalizedText;
  motto?: LocalizedText;
  description?: LocalizedRichText;
  rules?: LocalizedRichText;
  modApprovalToJoin?: boolean;
  onlyModsCanBlog?: boolean;
  originalLanguage?: string;
}

class TeamProvider extends AbstractBREADProvider {
  static formDefs: Record<string, FormField[]>;
  protected isPreview = false;
  protected editing = false;
  protected declare format?: string;
  protected declare language?: string;

  constructor(
    req: HandlerRequest,
    res: HandlerResponse,
    next: HandlerNext,
    options?: Record<string, unknown>
  ) {
    super(req, res, next, options);
    this.addPreFlightCheck(['add', 'edit', 'delete'], this.userIsTrusted);
    this.actions.browse.titleKey = 'browse teams';
    this.actions.add.titleKey = 'new team';
    this.actions.edit.titleKey = 'edit team';
    this.actions.delete.titleKey = 'delete team';

    this.actions.read.loadData = this.loadDataWithMostRecentReview;

    // Membership roster
    this.actions.members = {
      GET: this.members_GET,
      loadData: this.loadData,
      titleKey: 'membership roster',
      preFlightChecks: [],
    };

    this.actions.feed = {
      GET: this.feed_GET,
      loadData: this.loadDataWithFeed,
      preFlightChecks: [],
      titleKey: 'team feed',
    };

    // Join request management for closed teams
    this.actions.manageRequests = {
      GET: this.manageRequests_GET,
      POST: this.manageRequests_POST,
      loadData: this.loadDataWithJoinRequestDetails,
      titleKey: 'manage team requests',
      preFlightChecks: [this.userIsSignedIn],
    };

    this.messageKeyPrefix = 'team';
  }

  browse_GET(): void {
    Team.filterWhere({})
      .run()
      .then(teams => {
        this.renderTemplate('teams', {
          teams,
          titleKey: this.actions.browse.titleKey,
          deferPageHeader: true,
        });
      })
      .catch(this.next);
  }

  members_GET(team: TeamInstance): void {
    // For easy lookup in template
    const founder: Record<string, boolean> = {};
    if (typeof team.createdBy === 'string') founder[team.createdBy] = true;
    const moderators: Record<string, boolean> = {};
    const moderatorList: UserView[] = Array.isArray(team.moderators) ? team.moderators : [];
    moderatorList.forEach(moderator => (moderators[moderator.id] = true));

    const titleParam = mlString.resolve(
      typeof this.req.locale === 'string' ? this.req.locale : 'en',
      team.name as MultilingualString
    )?.str;

    this.renderTemplate('team-roster', {
      team,
      teamURL: `/team/${team.urlID}`,
      founder,
      moderators,
      titleKey: this.actions.members.titleKey,
      titleParam,
      deferPageHeader: true, // embedded link
    });
  }

  manageRequests_GET(team: TeamInstance): void {
    let pageErrors = this.req.flash('pageErrors');
    let pageMessages = this.req.flash('pageMessages');

    team.populateUserInfo(this.req.user);

    // Only show pending requests. Filter out rejected, withdrawn, and approved.
    const filteredJoinRequests = Array.isArray(team.joinRequests)
      ? team.joinRequests.filter(request => request.status === 'pending')
      : [];
    team.joinRequests = filteredJoinRequests;

    if (!team.userIsModerator) return this.renderPermissionError();

    this.renderTemplate('team-manage-requests', {
      team,
      teamURL: `/team/${team.urlID}`,
      teamName: mlString.resolve(
        typeof this.req.locale === 'string' ? this.req.locale : 'en',
        team.name as MultilingualString
      )?.str,
      titleKey: 'manage join requests',
      pageErrors,
      pageMessages,
    });
  }

  async manageRequests_POST(team: TeamInstance): Promise<void> {
    // We use a safe loop function in this method - quiet, jshint:

    const currentUser = this.req.user;
    if (!currentUser) {
      this.renderSigninRequired();
      return;
    }

    team.populateUserInfo(currentUser);

    if (!team.userIsModerator) return this.renderPermissionError();

    const joinRequests: JoinRequestWithUser[] = team.joinRequests ?? [];
    team.joinRequests = joinRequests;

    // We keep track of whether we've done any work, so we can show an
    // approrpriate message, and know whether we have to run saveAll()
    let workToBeDone = false;
    const savePromises: Promise<unknown>[] = [];

    debug.db('POST body:', this.req.body);
    debug.db(
      'Join requests:',
      joinRequests.map(r => ({ id: r.id, userID: r.userID }))
    );

    for (const key in this.req.body as Record<string, unknown>) {
      // Does it look like a request to perform an action?
      if (/^action-.+$/.test(key)) {
        // Safely extract the provided ID
        let id = (key.match(/action-(.*)$/) || [])[1];
        debug.db(`Found action key: ${key}, extracted ID: ${id}, action: ${this.req.body[key]}`);

        // Check if we do in fact have a join request that matches the action ID
        let requestIndex, requestObj;
        joinRequests.forEach((request, index) => {
          if (request.id == id) {
            requestObj = request;
            requestIndex = index;
          }
        });

        debug.db(`Match found: ${!!requestObj}`);

        // If we do, perform the appropriate work
        if (requestObj) {
          switch (this.req.body[key]) {
            case 'reject': {
              requestObj.rejectionDate = new Date();
              requestObj.rejectedBy = currentUser.id;
              requestObj.status = 'rejected';
              const reasonValue = this.req.body[`reject-reason-${id}`];
              const reason = typeof reasonValue === 'string' ? reasonValue : undefined;
              if (reason) requestObj.rejectionMessage = escapeHTML(reason);
              savePromises.push(requestObj.save());
              workToBeDone = true;
              break;
            }
            case 'accept': {
              requestObj.status = 'approved';
              // Save the join request status, then add user to team
              const savePromise = requestObj.save().then(() => {
                const teamMembers: UserView[] = Array.isArray(team.members)
                  ? [...team.members]
                  : [];
                if (requestObj.user) teamMembers.push(requestObj.user);
                team.members = teamMembers;
                // Remove from the array after accepting
                joinRequests.splice(requestIndex, 1);
              });
              savePromises.push(savePromise);
              workToBeDone = true;
              break;
            }
            // no default
          }
        }
      }
    }
    if (workToBeDone) {
      try {
        // Wait for all request saves to complete before saving team
        await Promise.all(savePromises);
        await team.saveAll();
        this.req.flash('pageMessages', this.req.__('requests have been processed'));
        this.res.redirect(`/team/${team.urlID}/manage-requests`);
      } catch (error) {
        this.next(error);
      }
    } else {
      this.req.flash('pageErrors', this.req.__('no requests to process'));
      this.res.redirect(`/team/${team.urlID}/manage-requests`);
    }
  }

  // For incomplete submissions, pass formValues so form can be pre-populated.
  add_GET(formValues?: TeamFormValues): void {
    let pageErrors = this.req.flash('pageErrors');
    this.renderTemplate(
      'team-form',
      {
        titleKey: this.actions[this.action].titleKey,
        pageErrors: this.isPreview ? undefined : pageErrors,
        formValues,
        isPreview: this.isPreview,
        scripts: ['editor'],
      },
      {
        messages: getEditorMessages(typeof this.req.locale === 'string' ? this.req.locale : 'en'),
      }
    );
  }

  loadData(): Promise<TeamInstance> {
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id);
  }

  // We just show a single review on the team entry page
  loadDataWithMostRecentReview(): Promise<TeamInstance> {
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id, {
      withReviews: true,
    });
  }

  // This is for feed or feed/before/<date> requests
  loadDataWithFeed(): Promise<TeamInstance> {
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id, {
      withReviews: true,
      reviewLimit: 10,
      reviewOffsetDate: this.offsetDate || null,
    });
  }

  loadDataWithJoinRequestDetails(): Promise<TeamInstance> {
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id, {
      withJoinRequestDetails: true,
    });
  }

  edit_GET(team: TeamInstance | TeamFormValues): void {
    this.add_GET(team as TeamFormValues);
  }

  async read_GET(team: TeamInstance): Promise<void> {
    team.populateUserInfo(this.req.user);
    const reviews = Array.isArray(team.reviews) ? team.reviews : [];
    team.reviews = reviews;
    reviews.forEach(review => review.populateUserInfo(this.req.user));

    const currentLocale = typeof this.req.locale === 'string' ? this.req.locale : 'en';
    let titleParam = mlString.resolve(currentLocale, team.name as MultilingualString)?.str ?? '';

    // Error messages from any join attempts
    let joinErrors = this.req.flash('joinErrors');

    if (this.req.user && !team.userIsModerator && !team.userIsMember && team.joinRequests)
      team.joinRequests.forEach(request => {
        if (request.userID === this.req.user.id) {
          // Only show messages for pending or rejected requests, not withdrawn/approved
          if (request.status === 'pending') {
            this.req.flash('pageMessages', this.req.__('application received'));
          } else if (request.status === 'rejected') {
            const rejectionDate = request.rejectionDate ? String(request.rejectionDate) : '';
            if (request.rejectionMessage)
              this.req.flash(
                'pageMessages',
                this.req.__(
                  'application rejected with reason',
                  rejectionDate,
                  request.rejectionMessage
                )
              );
            else this.req.flash('pageMessages', this.req.__('application rejected', rejectionDate));
          }
          // Don't show anything for withdrawn or approved status
        }
      });

    if (team.userIsModerator && team.joinRequests) {
      let joinRequestCount = team.joinRequests.filter(
        request => request.status === 'pending'
      ).length;
      let url = `/team/${team.urlID}/manage-requests`;
      if (joinRequestCount == 1)
        this.req.flash('pageMessages', this.req.__('pending join request', url));
      else if (joinRequestCount > 1)
        this.req.flash(
          'pageMessages',
          this.req.__('pending join requests', url, String(joinRequestCount))
        );
    }

    // Used for "welcome to the team" messages
    let pageMessages = this.req.flash('pageMessages');

    // For easy lookup in template
    const founder: Record<string, boolean> = {};
    if (typeof team.createdBy === 'string') founder[team.createdBy] = true;

    BlogPost.getMostRecentBlogPosts(team.id, {
      limit: 3,
    }).then(result => {
      let blogPosts = result.blogPosts ?? [];
      let offsetDate = result.offsetDate;

      blogPosts.forEach(post => post.populateUserInfo(this.req.user));

      let embeddedFeeds = feeds.getEmbeddedFeeds(this.req, {
        atomURLPrefix: `/team/${team.urlID}/blog/atom`,
        atomURLTitleKey: 'atom feed of blog posts by team',
      });

      embeddedFeeds = embeddedFeeds.concat(
        feeds.getEmbeddedFeeds(this.req, {
          atomURLPrefix: `/team/${team.urlID}/feed/atom`,
          atomURLTitleKey: 'atom feed of reviews by team',
        })
      );

      let paginationURL;
      const reviewOffsetDate = team.reviewOffsetDate as Date | null | undefined;
      if (reviewOffsetDate)
        paginationURL = `/team/${team.urlID}/feed/before/${reviewOffsetDate.toISOString()}`;

      this.renderTemplate('team', {
        team,
        titleKey: 'team title',
        titleParam,
        blogPosts,
        joinErrors,
        pageMessages,
        founder,
        embeddedFeeds,
        paginationURL,
        blogPostsUTCISODate: offsetDate ? offsetDate.toISOString() : undefined,
        deferPageHeader: true, // Two-column-layout
      });
    });
  }

  feed_GET(team: TeamInstance): void {
    team.populateUserInfo(this.req.user);
    const reviews = Array.isArray(team.reviews) ? team.reviews : [];
    team.reviews = reviews;

    // For machine-readable feeds
    if (this.format && typeof this.language === 'string') i18n.setLocale(this.req, this.language);

    let updatedDate;
    reviews.forEach(review => {
      review.populateUserInfo(this.req.user);
      if (review.thing) review.thing.populateUserInfo(this.req.user);
      // For Atom feed - most recently modified item in the result set
      if (!updatedDate || review._revDate > updatedDate) updatedDate = review._revDate;
    });

    const currentLocale = typeof this.req.locale === 'string' ? this.req.locale : 'en';
    let titleParam = mlString.resolve(currentLocale, team.name as MultilingualString)?.str ?? '';

    // Atom feed metadata for <link> tags in HTML version
    let atomURLPrefix = `/team/${team.urlID}/feed/atom`;
    let embeddedFeeds = feeds.getEmbeddedFeeds(this.req, {
      atomURLPrefix,
      atomURLTitleKey: 'atom feed of reviews by team',
    });

    let paginationURL;
    const feedOffsetDate = team.reviewOffsetDate as Date | null | undefined;
    if (feedOffsetDate)
      paginationURL = `/team/${team.urlID}/feed/before/${feedOffsetDate.toISOString()}`;

    let vars = {
      team,
      teamURL: `/team/${team.urlID}`,
      feedItems: team.reviews,
      titleKey: 'team feed',
      titleParam,
      embeddedFeeds,
      deferPageHeader: true, // embedded link
      paginationURL,
    };

    if (this.format) {
      if (this.format == 'atom') {
        Object.assign(vars, {
          layout: 'layout-atom',
          language: this.language,
          updatedDate,
          selfURL: url.resolve(config.qualifiedURL, `${atomURLPrefix}/${this.language ?? 'en'}`),
          htmlURL: url.resolve(config.qualifiedURL, `/team/${team.urlID}/feed`),
        });
        this.res.type('application/atom+xml');
        this.renderTemplate('review-feed-atom', vars);
      } else {
        this.next(new Error(`Format ${this.format} not supported`));
      }
    } else {
      this.renderTemplate('team-feed', vars);
    }
  }

  edit_POST(team: TeamInstance): void {
    const formKey = 'edit-team';
    const languageValue = this.req.body?.['team-language'];
    const language: string =
      typeof languageValue === 'string' ? languageValue : (team.originalLanguage ?? 'en');
    const formData = this.parseForm({
      formDef: TeamProvider.formDefs[formKey],
      formKey,
      language,
    });

    const formValues = formData.formValues as TeamFormValues;

    this.isPreview = this.req.body?.['team-action'] === 'preview';

    if (this.req.flashHas?.('pageErrors') || this.isPreview) return this.edit_GET(formValues);

    const currentUser = this.req.user;
    if (!currentUser) return this.renderSigninRequired();

    team
      .newRevision(currentUser, {
        tags: ['edit-via-form'],
      })
      .then(newRev => {
        const source = formValues;
        const motto = newRev.motto as MultilingualString;
        const name = newRev.name as MultilingualString;
        const description = newRev.description as {
          text: MultilingualString;
          html: MultilingualString;
        };
        const rules = newRev.rules as {
          text: MultilingualString;
          html: MultilingualString;
        };
        const sourceMotto = (source.motto ?? {}) as MultilingualString;
        const sourceName = (source.name ?? {}) as MultilingualString;
        const sourceDescription = (source.description ?? {}) as {
          text?: MultilingualString;
          html?: MultilingualString;
        };
        const sourceRules = (source.rules ?? {}) as {
          text?: MultilingualString;
          html?: MultilingualString;
        };

        motto[language] = sourceMotto[language] ?? '';
        name[language] = sourceName[language] ?? '';
        description.text[language] = sourceDescription.text?.[language] ?? '';
        description.html[language] = sourceDescription.html?.[language] ?? '';
        rules.text[language] = sourceRules.text?.[language] ?? '';
        rules.html[language] = sourceRules.html?.[language] ?? '';
        newRev.onlyModsCanBlog = source.onlyModsCanBlog;
        newRev.modApprovalToJoin = source.modApprovalToJoin;

        newRev
          .updateSlug(currentUser.id, language)
          .then(updatedRev => {
            updatedRev
              .save()
              .then(savedRev => this.res.redirect(`/team/${savedRev.urlID}`))
              .catch(this.next);
          })
          // Slug update failed
          .catch(error => {
            if (error.name === 'DuplicateSlugNameError') {
              this.req.flash(
                'pageErrors',
                this.req.__('duplicate team name', `/team/${error.payload.slug.name}`)
              );
              return this.edit_GET(formValues);
            } else return this.next(error);
          });
      })
      .catch(this.next); // Creating new revision failed
  }

  add_POST(): void {
    const formKey = 'new-team';
    const languageValue = this.req.body?.['team-language'];
    const language: string = typeof languageValue === 'string' ? languageValue : 'en';
    const formData = this.parseForm({
      formDef: TeamProvider.formDefs[formKey],
      formKey,
      language,
    });

    const formValues = formData.formValues as TeamFormValues;

    this.isPreview = this.req.body?.['team-action'] === 'preview';

    if (this.req.flashHas?.('pageErrors') || this.isPreview) return this.add_GET(formValues);

    const currentUser = this.req.user;
    if (!currentUser) return this.renderSigninRequired();

    Team.createFirstRevision(currentUser, {
      tags: ['create-via-form'],
    })
      .then(newTeam => {
        // Associate parsed form data with revision
        Object.assign(newTeam, formValues);

        // Ensure team has an ID before proceeding
        if (!newTeam.id) {
          newTeam.id = randomUUID();
        }

        // Creator is first moderator
        newTeam.moderators = [currentUser];

        // Creator is first member
        newTeam.members = [currentUser];

        // Founder warrants special recognition
        newTeam.createdBy = currentUser.id;
        newTeam.createdOn = new Date();

        // Save team first to satisfy foreign key constraints
        newTeam
          .save()
          .then((saved: TeamInstance) => {
            const savedTeam = saved;
            // Then update slug (after team exists in DB)
            return savedTeam.updateSlug(currentUser.id, savedTeam.originalLanguage);
          })
          .then(team => {
            // Save again if slug updated the canonicalSlugName, and save members/moderators
            return team.saveAll();
          })
          .then(team => this.res.redirect(`/team/${team.urlID}`))
          // Problem saving team or updating slug
          .catch(error => {
            if (error.name === 'DuplicateSlugNameError') {
              this.req.flash(
                'pageErrors',
                this.req.__('duplicate team name', `/team/${error.payload.slug.name}`)
              );
              return this.add_GET(formValues);
            } else return this.next(error);
          });
      })
      // Problem getting metadata for new revision
      .catch(this.next);
  }

  delete_GET(team: TeamInstance): void {
    let pageErrors = this.req.flash('pageErrors');
    this.renderTemplate('team', {
      team,
      titleKey: this.actions[this.action].titleKey,
      deferPageHeader: true,
      pageErrors,
      deleteForm: true,
    });
  }

  delete_POST(team: TeamInstance): void {
    team
      .deleteAllRevisions(this.req.user, {
        tags: ['delete-via-form'],
      })
      .then(() => {
        this.renderTemplate('team-deleted', {
          titleKey: 'team deleted',
        });
      })
      .catch(this.next);
  }
}

// Shared by all instances
TeamProvider.formDefs = {
  'new-team': [
    {
      name: 'team-name',
      required: true,
      type: 'text',
      key: 'name',
    },
    {
      name: 'team-motto',
      required: true,
      type: 'text',
      key: 'motto',
    },
    {
      name: 'team-description',
      required: true,
      type: 'markdown',
      key: 'description',
    },
    {
      name: 'team-rules',
      required: false,
      type: 'markdown',
      key: 'rules',
    },
    {
      name: 'team-mod-approval-to-join',
      required: false,
      type: 'boolean',
      key: 'modApprovalToJoin',
    },
    {
      name: 'team-only-mods-can-blog',
      required: false,
      type: 'boolean',
      key: 'onlyModsCanBlog',
    },
    {
      name: 'team-language',
      required: true,
      key: 'originalLanguage',
    },
    {
      name: 'team-action',
      required: true,
      skipValue: true, // Only logic, not saved
    },
  ],
};

TeamProvider.formDefs['edit-team'] = TeamProvider.formDefs['new-team'];

export default TeamProvider;
