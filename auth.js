'use strict';

// External deps
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;

// Internal deps
const User = require('./models/user');

passport.serializeUser(function(user, done) {
  done(null, user.id);
});

passport.deserializeUser(async function(id, done) {
  try {

    const user = await User.getWithTeams(id);
    return done(null, user);
  } catch (error) {
    return done(error);
  }
});

passport.use(new LocalStrategy(
  async function(username, password, done) {
    try {

      const users = await User
        .filter({
          canonicalName: User.canonicalize(username)
        })
        .limit(1)
        .run();

      if (!users.length) {
        return done(null, false, {
          message: 'bad username'
        });
      }

      const user = users[0];
      const passwordMatches = await user.checkPassword(password);

      if (!passwordMatches) {
        return done(null, false, {
          message: 'bad password'
        });
      }

      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));
