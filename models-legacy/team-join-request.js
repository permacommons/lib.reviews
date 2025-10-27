'use strict';
const thinky = require('../db');
const type = thinky.type;
const Team = require('./team');
const User = require('./user');

// Eventually, we'll want to move some of this into proper notifications,
// possibly with an external message queue, but it's all handled on the team
// page and inside this table for now.
let teamJoinRequestSchema = {
  id: type.string().uuid(4),
  teamID: type.string().uuid(4),
  userID: type.string().uuid(4),
  requestMessage: type.string(),
  requestDate: type.date(),
  rejectedBy: type.string().uuid(4),
  rejectionDate: type.date(), // We remove fulfilled requests, and date rejected ones
  rejectionMessage: type.string(),
  rejectedUntil: type.date() // TBD. If not specified, user can re-apply immediately.
};

let TeamJoinRequest = thinky.createModel("team_join_requests", teamJoinRequestSchema);

// Facilitate joining a team to its requests
Team.hasMany(TeamJoinRequest, "joinRequests", "id", "teamID");
// Facilitate joining a request to its team
TeamJoinRequest.belongsTo(Team, "team", "teamID", "id");
// Facilitate joining a request to its user
TeamJoinRequest.belongsTo(User, "user", "userID", "id");

module.exports = TeamJoinRequest;
