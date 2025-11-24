import escapeHTML from 'escape-html';
import mlString from '../dal/lib/ml-string.ts';
import languages from '../locales/languages.ts';
import type { TeamInstance } from '../models/manifests/team.ts';
import TeamJoinRequest from '../models/team-join-request.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import getResourceErrorHandler from './handlers/resource-error-handler.ts';
import TeamProvider from './handlers/team-provider.ts';
import render from './helpers/render.ts';
import slugs from './helpers/slugs.ts';

// Default routes for read, edit, add, delete
type TeamRouteRequest<Params extends Record<string, string> = Record<string, string>> =
  HandlerRequest<Params>;
type TeamRouteResponse = HandlerResponse;

const router = TeamProvider.bakeRoutes('team');

router.get('/team', (_req: TeamRouteRequest, res: TeamRouteResponse) => res.redirect('/teams'));

// Feed of all reviews
router.get(
  '/team/:id/feed',
  (req: TeamRouteRequest<{ id: string }>, res: TeamRouteResponse, next: HandlerNext) => {
    const teamProvider = new TeamProvider(req, res, next, {
      action: 'feed',
      method: 'GET',
      id: req.params.id,
    });
    teamProvider.execute();
  }
);

// Feed of all reviews before a given date
router.get(
  '/team/:id/feed/before/:utcisodate',
  (
    req: TeamRouteRequest<{ id: string; utcisodate: string }>,
    res: TeamRouteResponse,
    next: HandlerNext
  ) => {
    let offsetDate = new Date(req.params.utcisodate);
    if (Number.isNaN(offsetDate.getTime())) offsetDate = null;

    let teamProvider = new TeamProvider(req, res, next, {
      action: 'feed',
      method: 'GET',
      id: req.params.id,
      offsetDate,
    });
    teamProvider.execute();
  }
);

router.get('/team/:id/feed/atom', (req: TeamRouteRequest<{ id: string }>, res: TeamRouteResponse) =>
  res.redirect(`/team/${req.params.id}/feed/atom/${req.locale}`)
);

// Feed of all reviews in Atom format
router.get(
  '/team/:id/feed/atom/:language',
  (
    req: TeamRouteRequest<{ id: string; language: string }>,
    res: TeamRouteResponse,
    next: HandlerNext
  ) => {
    let { language } = req.params;
    if (!languages.isValid(language)) language = 'en';

    let teamProvider = new TeamProvider(req, res, next, {
      action: 'feed',
      method: 'GET',
      id: req.params.id,
      format: 'atom',
      language,
    });
    teamProvider.execute();
  }
);

// Show list of all teams
router.get('/teams', (req: TeamRouteRequest, res: TeamRouteResponse, next: HandlerNext) => {
  let teamProvider = new TeamProvider(req, res, next, {
    action: 'browse',
    method: 'GET',
  });
  teamProvider.execute();
});

// Show membership roster for a specific team
router.get(
  '/team/:id/members',
  (req: TeamRouteRequest<{ id: string }>, res: TeamRouteResponse, next: HandlerNext) => {
    let teamProvider = new TeamProvider(req, res, next, {
      action: 'members',
      method: 'GET',
      id: req.params.id,
    });
    teamProvider.execute();
  }
);

// Moderator tool for managing requests which require moderator approval
router.get(
  '/team/:id/manage-requests',
  (req: TeamRouteRequest<{ id: string }>, res: TeamRouteResponse, next: HandlerNext) => {
    let teamProvider = new TeamProvider(req, res, next, {
      action: 'manageRequests',
      method: 'GET',
      id: req.params.id,
    });
    teamProvider.execute();
  }
);

// Moderator tool for managing requests which require moderator approval
router.post(
  '/team/:id/manage-requests',
  (req: TeamRouteRequest<{ id: string }>, res: TeamRouteResponse, next: HandlerNext) => {
    let teamProvider = new TeamProvider(req, res, next, {
      action: 'manageRequests',
      method: 'POST',
      id: req.params.id,
    });
    teamProvider.execute();
  }
);

// Process join requests, form is on team page itself
router.post(
  '/team/:id/join',
  (req: TeamRouteRequest<{ id: string }>, res: TeamRouteResponse, next: HandlerNext) => {
    const { id } = req.params;
    const currentUser = req.user;
    if (!currentUser) return render.signinRequired(req, res);

    slugs
      .resolveAndLoadTeam(req, res, id)
      .then((team: TeamInstance) => {
        const loadedTeam = team;
        loadedTeam.populateUserInfo(currentUser);
        if (!loadedTeam.userCanJoin) return render.permissionError(req, res);

        const rulesHtml = loadedTeam.rules?.html as Record<string, string> | undefined;

        if (rulesHtml && mlString.resolve(req.locale, rulesHtml) && !req.body['agree-to-rules']) {
          req.flash('joinErrors', req.__('must agree to team rules'));
          return res.redirect(`/team/${id}`);
        }

        const joinRequests = Array.isArray(loadedTeam.joinRequests) ? loadedTeam.joinRequests : [];

        if (loadedTeam.modApprovalToJoin) {
          // Check if there's an existing join request (withdrawn, rejected, or approved)
          const existingRequest = joinRequests.find(jr => jr.userID === currentUser.id);

          const joinRequestMessageInput = req.body['join-request-message'];
          const joinRequestMessage =
            typeof joinRequestMessageInput === 'string' ? joinRequestMessageInput.trim() : '';

          if (existingRequest) {
            // Update existing request
            existingRequest.status = 'pending';
            existingRequest.requestMessage = escapeHTML(joinRequestMessage);
            existingRequest.requestDate = new Date();
            existingRequest.rejectionDate = null;
            existingRequest.rejectedBy = null;
            existingRequest.rejectionMessage = null;
            existingRequest
              .save()
              .then(() => {
                res.redirect(`/team/${id}`);
              })
              .catch(next);
          } else {
            // Create new request
            let teamJoinRequest = new TeamJoinRequest({
              teamID: loadedTeam.id,
              userID: currentUser.id,
              requestMessage: escapeHTML(joinRequestMessage),
              requestDate: new Date(),
            });
            teamJoinRequest
              .save()
              .then(() => {
                res.redirect(`/team/${id}`);
              })
              .catch(next); // Problem saving join request
          }
        } else {
          // No approval required, just add the new member

          const members = Array.isArray(loadedTeam.members) ? [...loadedTeam.members] : [];
          members.push(currentUser);
          loadedTeam.members = members;

          loadedTeam
            .saveAll()
            .then(() => {
              req.flash('pageMessages', req.__('welcome to the team'));
              res.redirect(`/team/${id}`);
            })
            .catch(next); // Problem saving user changes
        }
      })
      .catch(getResourceErrorHandler(req, res, next, 'team', id));
  }
);

// Process leave requests, form is on team page itself
router.post(
  '/team/:id/leave',
  (req: TeamRouteRequest<{ id: string }>, res: TeamRouteResponse, next: HandlerNext) => {
    const { id } = req.params;
    const currentUser = req.user;
    if (!currentUser) return render.signinRequired(req, res);

    slugs
      .resolveAndLoadTeam(req, res, id)
      .then((team: TeamInstance) => {
        const loadedTeam = team;
        loadedTeam.populateUserInfo(currentUser);
        if (!loadedTeam.userCanLeave) return render.permissionError(req, res);

        const members = Array.isArray(loadedTeam.members) ? loadedTeam.members : [];
        loadedTeam.members = members.filter(member => member.id !== currentUser.id);
        const moderators = Array.isArray(loadedTeam.moderators) ? loadedTeam.moderators : [];
        loadedTeam.moderators = moderators.filter(moderator => moderator.id !== currentUser.id);

        // Mark any existing join request as withdrawn
        const joinRequests = Array.isArray(loadedTeam.joinRequests) ? loadedTeam.joinRequests : [];
        const existingRequest = joinRequests.find(jr => jr.userID === currentUser.id);

        if (existingRequest) existingRequest.status = 'withdrawn';

        const savePromises = [
          loadedTeam.saveAll(),
          ...(existingRequest ? [existingRequest.save()] : []),
        ];

        Promise.all(savePromises)
          .then(() => {
            req.flash('pageMessages', req.__('goodbye team'));
            res.redirect(`/team/${id}`);
          })
          .catch(next); // Problem saving user changes
      })
      .catch(getResourceErrorHandler(req, res, next, 'team', id));
  }
);

export default router;
