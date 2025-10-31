import escapeHTML from 'escape-html';

import TeamProvider from './handlers/team-provider.mjs';
import TeamJoinRequest from '../models/team-join-request.mjs';
import getResourceErrorHandler from './handlers/resource-error-handler.mjs';
import render from './helpers/render.mjs';
import mlString from '../dal/lib/ml-string.mjs';
import languages from '../locales/languages.mjs';
import slugs from './helpers/slugs.mjs';

// Default routes for read, edit, add, delete
const router = TeamProvider.bakeRoutes('team');

router.get('/team', (req, res) => res.redirect('/teams'));

// Feed of all reviews
router.get('/team/:id/feed', (req, res, next) => {
  const teamProvider = new TeamProvider(req, res, next, {
    action: 'feed',
    method: 'GET',
    id: req.params.id
  });
  teamProvider.execute();
});

// Feed of all reviews before a given date
router.get('/team/:id/feed/before/:utcisodate', (req, res, next) => {
  let offsetDate = new Date(req.params.utcisodate);
  if (!offsetDate || offsetDate == 'Invalid Date')
    offsetDate = null;

  let teamProvider = new TeamProvider(req, res, next, {
    action: 'feed',
    method: 'GET',
    id: req.params.id,
    offsetDate
  });
  teamProvider.execute();
});

router.get('/team/:id/feed/atom', (req, res) =>
  res.redirect(`/team/${req.params.id}/feed/atom/${req.locale}`)
);

// Feed of all reviews in Atom format
router.get('/team/:id/feed/atom/:language', (req, res, next) => {
  let { language } = req.params;
  if (!languages.isValid(language))
    language = 'en';

  let teamProvider = new TeamProvider(req, res, next, {
    action: 'feed',
    method: 'GET',
    id: req.params.id,
    format: 'atom',
    language
  });
  teamProvider.execute();
});


// Show list of all teams
router.get('/teams', function(req, res, next) {
  let teamProvider = new TeamProvider(req, res, next, {
    action: 'browse',
    method: 'GET'
  });
  teamProvider.execute();
});

// Show membership roster for a specific team
router.get('/team/:id/members', function(req, res, next) {
  let teamProvider = new TeamProvider(req, res, next, {
    action: 'members',
    method: 'GET',
    id: req.params.id
  });
  teamProvider.execute();
});

// Moderator tool for managing requests which require moderator approval
router.get('/team/:id/manage-requests', function(req, res, next) {
  let teamProvider = new TeamProvider(req, res, next, {
    action: 'manageRequests',
    method: 'GET',
    id: req.params.id
  });
  teamProvider.execute();
});

// Moderator tool for managing requests which require moderator approval
router.post('/team/:id/manage-requests', function(req, res, next) {
  let teamProvider = new TeamProvider(req, res, next, {
    action: 'manageRequests',
    method: 'POST',
    id: req.params.id
  });
  teamProvider.execute();
});

// Process join requests, form is on team page itself
router.post('/team/:id/join', function(req, res, next) {
  const { id } = req.params;
  slugs
    .resolveAndLoadTeam(req, res, id)
    .then(team => {
      team.populateUserInfo(req.user);
      if (!team.userCanJoin)
        return render.permissionError(req, res);

      if (team.rules && mlString.resolve(req.locale, team.rules.html) &&
        !req.body['agree-to-rules']) {
        req.flash('joinErrors', req.__('must agree to team rules'));
        return res.redirect(`/team/${id}`);
      }

      if (team.modApprovalToJoin) {
        // Check if there's an existing join request (withdrawn, rejected, or approved)
        const existingRequest = team.joinRequests.find(jr => jr.userID === req.user.id);

        if (existingRequest) {
          // Update existing request
          existingRequest.status = 'pending';
          existingRequest.requestMessage = escapeHTML(req.body['join-request-message'].trim());
          existingRequest.requestDate = new Date();
          existingRequest.rejectionDate = null;
          existingRequest.rejectedBy = null;
          existingRequest.rejectionMessage = null;
          existingRequest.save().then(() => {
            res.redirect(`/team/${id}`);
          })
          .catch(next);
        } else {
          // Create new request
          let teamJoinRequest = new TeamJoinRequest({
            teamID: team.id,
            userID: req.user.id,
            requestMessage: escapeHTML(req.body['join-request-message'].trim()),
            requestDate: new Date()
          });
          teamJoinRequest.save().then(() => {
            res.redirect(`/team/${id}`);
          })
          .catch(next); // Problem saving join request
        }

      } else { // No approval required, just add the new member

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
});

// Process leave requests, form is on team page itself
router.post('/team/:id/leave', function(req, res, next) {
  const { id } = req.params;
  slugs
    .resolveAndLoadTeam(req, res, id)
    .then(team => {
      team.populateUserInfo(req.user);
      if (!team.userCanLeave)
        return render.permissionError(req, res);

      team.members = team.members.filter(member => member.id !== req.user.id);
      team.moderators = team.moderators.filter(moderator => moderator.id !== req.user.id);

      // Mark any existing join request as withdrawn
      const existingRequest = team.joinRequests.find(jr => jr.userID === req.user.id);
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
});

export default router;
