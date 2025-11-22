import escapeHTML from 'escape-html';
import mlString from '../dal/lib/ml-string.ts';
import languages from '../locales/languages.ts';
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
    slugs
      .resolveAndLoadTeam(req, res, id)
      .then(team => {
        team.populateUserInfo(req.user);
        if (!team.userCanJoin) return render.permissionError(req, res);

        if (
          team.rules &&
          mlString.resolve(req.locale, team.rules.html) &&
          !req.body['agree-to-rules']
        ) {
          req.flash('joinErrors', req.__('must agree to team rules'));
          return res.redirect(`/team/${id}`);
        }

        if (team.modApprovalToJoin) {
          // Check if there's an existing join request (withdrawn, rejected, or approved)
          const existingRequest = team.joinRequests.find(
            (jr: Record<string, any>) => jr.userID === req.user.id
          );

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
              teamID: team.id,
              userID: req.user.id,
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

          team.members.push(req.user);
          team
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
    slugs
      .resolveAndLoadTeam(req, res, id)
      .then(team => {
        team.populateUserInfo(req.user);
        if (!team.userCanLeave) return render.permissionError(req, res);

        team.members = team.members.filter(member => member.id !== req.user.id);
        team.moderators = team.moderators.filter(moderator => moderator.id !== req.user.id);

        // Mark any existing join request as withdrawn
        const existingRequest = team.joinRequests.find(
          (jr: Record<string, any>) => jr.userID === req.user.id
        );
        const savePromises = [team.saveAll()];

        if (existingRequest) {
          existingRequest.status = 'withdrawn';
          savePromises.push(existingRequest.save());
        }

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
