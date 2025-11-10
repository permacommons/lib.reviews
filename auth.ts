import type { Express } from 'express';
import passport from 'passport';
import passportLocal from 'passport-local';
import User, { type UserInstance } from './models/user.ts';

const { Strategy: LocalStrategy } = passportLocal;

type SerializedId = string | number;

type DeserializeCallback = (err: unknown, user?: Express.User | false | null) => void;

type VerifyCallback = (
  error: unknown,
  user?: Express.User | false,
  options?: passportLocal.IVerifyOptions
) => void;

passport.serializeUser((user: Express.User, done: (err: unknown, id?: SerializedId) => void) => {
  done(null, String(user.id));
});

passport.deserializeUser(async (id: unknown, done: DeserializeCallback) => {
  const userId = String(id);
  try {
    const user = await User.getWithTeams(userId);
    return done(null, user);
  } catch (error) {
    return done(error);
  }
});

const verify: passportLocal.VerifyFunction = async (username, password, done: VerifyCallback) => {
  try {
    const users: UserInstance[] = await User.filterWhere({
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

    return done(null, user);
  } catch (error) {
    return done(error);
  }
};

passport.use(new LocalStrategy(verify));

export default passport;
