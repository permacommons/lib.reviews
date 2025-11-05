import type { Express } from 'express';
import passport from 'passport';
import passportLocal from 'passport-local';
import User from './models/user.ts';

const { Strategy: LocalStrategy } = passportLocal;

type SerializedId = string | number;

type DeserializeCallback = (err: unknown, user?: Express.User | false | null) => void;

type VerifyCallback = (
  error: unknown,
  user?: Express.User | false,
  options?: passportLocal.IVerifyOptions
) => void;

passport.serializeUser((user: Express.User, done: (err: unknown, id?: SerializedId) => void) => {
  done(null, user.id as SerializedId);
});

passport.deserializeUser(async function (id: unknown, done: DeserializeCallback) {
  const userId = id as SerializedId;
  try {
    const user = await User.getWithTeams(userId);
    return done(null, user as Express.User | null);
  } catch (error) {
    return done(error);
  }
});

const verify: passportLocal.VerifyFunction = async (username, password, done: VerifyCallback) => {
  try {
    const users = await User.filter({
      canonicalName: User.canonicalize(username),
    })
      .includeSensitive(['password'])
      .limit(1)
      .run();

    if (!users.length) {
      return done(null, false, {
        message: 'bad username',
      });
    }

    const user = users[0];

    if (!user.password) {
      return done(null, false, {
        message: 'account locked',
      });
    }

    const passwordMatches = await user.checkPassword(password);

    if (!passwordMatches) {
      return done(null, false, {
        message: 'bad password',
      });
    }

    return done(null, user as Express.User);
  } catch (error) {
    return done(error);
  }
};

passport.use(new LocalStrategy(verify));

export default passport;
