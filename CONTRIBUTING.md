*Please also see the [code of conduct](https://github.com/permacommons/lib.reviews/blob/master/CODE_OF_CONDUCT.md).*

Thanks for taking a look! If you just want to write reviews, please see the [instructions for getting an account](https://lib.reviews/register). For technical/design contributions, read on.

We welcome contributions to [any of our open issues](https://github.com/permacommons/lib.reviews/issues), as well as new ideas. Issues tagged as "[good for new contributors](https://github.com/permacommons/lib.reviews/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+for+new+contributors%22)" don't require in-depth knowledge of the whole codebase. We're happy to set aside time for personal coaching in the codebase (e.g., via video-conference/screen-sharing). Ping `Eloquence` on **#lib.reviews** on [libera.chat](https://libera.chat/) to get started.

# Technical overview

lib.reviews is a pure-JavaScript application, using modern language features where appropriate. Here are some of the specific technical choices we've made.

| Technology                               | Current use                              |
| ---------------------------------------- | ---------------------------------------- |
| [Node.js](https://nodejs.org/en/) 22.x (current release line) | lib.reviews server, API and tests        |
| [Express](https://expressjs.com/) (V4 series) | Framework for the web application        |
| [PostgreSQL](https://www.postgresql.org/) | Primary storage backend for text         |
| [ElasticSearch](https://www.elastic.co/) | Search backend                           |
| Custom DAL (`dal/`)                      | Data Access Layer for PostgreSQL with revision tracking |
| [Handlebars](http://handlebarsjs.com/)   | Front-end templates (currently only rendered server-side) |
| [LESS](http://lesscss.org/)              | CSS pre-processor, makes CSS easier to use |
| [PureCSS](https://purecss.io/)           | Grid system and basic styles             |
| [Vite](https://vite.dev/)                | Build pipeline for front-end assets (outputs in `build/vite`, middleware-mode HMR in development). |
| [Babel](https://babeljs.io/)             | Transpilation of front-end code that includes ES6 Javascript language features; transpilation of tests that include ES7 features |
| [ava](https://github.com/avajs/ava)      | Asynchronous test runner                 |
| [systemd](https://systemd.io/)           | Production service supervision using `deployment/libreviews.service.sample` |
| [ProseMirror](http://prosemirror.net/)   | Rich-text editor                         |
| [jQuery](https://jquery.com/)            | DOM manipulation                         |

This project follows a strong philosophy of progressive enhancement. That means that client-side UI features should always be optional, not required -- the primary functionality of the site should be available without JavaScript and on low-end devices.

We also try to add keyboard shortcuts where relevant, and generally follow existing conventions for those (from Wikipedia, Google and other sites).

We aim to be multilingual in UI and content, and are exclusively using translatable strings throughout the user interface.

# Getting started

This is very much an open project and we'd love your help! :) To get started, clone the repository to your local computer. You will need Node.js 22.x (the current release line we target). Switch to your check-out directory and then run `npm install`. Run `npm run build` to produce the Vite bundles. Make sure you also have PostgreSQL up and running before starting the service.

See `POSTGRES-SETUP.md` for instructions on setting up the PostgreSQL database.

You can customize your development configuration by copying `config/default.json5` to `config/development.json5`. Finally, run `npm run start-dev` and visit `localhost` at the configured port number. The npm scripts invoke `node bin/www.js` directly; in production we recommend adapting the sample systemd unit in `deployment/libreviews.service.sample`.

## Alternative: Dev server with system tray icon

If you're using a GNOME/GTK-based desktop environment (or any Linux system with a system tray), you can run the dev server with a handy tray icon:

```bash
npm run start-dev-yad
```

This requires `yad` (Yet Another Dialog), which is available in most Linux distribution repositories. The tray icon allows you to:
- Click to toggle the server on/off
- See server state at a glance (stop icon when running, play icon when stopped)
- Keep the dev server accessible without cluttering your workspace

Note: This is a GNOME-centric feature and may not work well on other desktop environments.

# Licensing and conduct

Any pull requests must be under the [CC-0 License](./LICENSE). This project has adopted a [code of conduct](./CODE_OF_CONDUCT.md) to make sure all contributors feel welcome.

# Running tests

Use `npm run test` to execute the AVA suite. The helper script automatically ensures a production Vite manifest exists, running `npm run build` on your behalf when necessary before starting the tests.

# Database Models

lib.reviews uses PostgreSQL as its database backend. The models use a camelCase accessor pattern for application code while using snake_case database columns.

## CamelCase Accessor Pattern

Models expose camelCase properties (e.g., `user.displayName`, `review.starRating`) that internally map to snake_case database columns (e.g., `display_name`, `star_rating`). This design provides:

- **Clean Interface**: Application code uses intuitive camelCase JavaScript conventions
- **Database Abstraction**: Snake_case database implementation is hidden from application code
- **Maintainability**: Clear separation between database schema and application API
- **Performance**: Minimal overhead through efficient property descriptors and field mapping caches

The mapping is handled automatically by the Model base class (`dal/lib/model.js`) using property descriptors and field mapping registries. Virtual fields (computed properties like `urlID`, `userCanEdit`) are generated dynamically and not stored in the database.

# Code style

- We generally use `// single-line comments` because they're more easy to add/remove in bulk.

- For functions with more than two arguments, we prefer to use `options` (for optional settings with defaults) or `spec` parameters (for required settings) that are destructured, like so:

  ```javascript
  let date = new Date(), user = 'unknown';
  hello({ recipient: 'World', sender: user, date });

  function hello(spec) {
    const { sender, recipient, date } = spec; // Destructuring
    console.log(`Hello ${recipient} from ${sender} on ${date}!`);
  }
  ```

  As the example shows, this makes argument oder irrelevant and increases the readability of the calling code. Note the use of shorthand for the `date` parameter.

  Exceptions to this rule are functions that always accepts certain well-known standard arguments (such as the `req, res, next` convention in Express).

- Object literals and arrow functions can be written on a single line.

- We use [eslint](http://eslint.org/)  with the [babel-eslint](https://github.com/babel/babel-eslint) package for automatic code linting, using the [.eslintrc](https://github.com/permacommons/lib.reviews/blob/master/.eslintrc.json) that's checked into the repository. This defines most of our other assumptions.

- Semicolons are nice. They help to navigate multi-line statements like this:

  ````javascript
  if (true)
    Promise.resolve()
    	.then(() => console.log('Done'))
    	.catch(() => console.log('Oh no'));
  ````

- Break chains for readability at about ~3 or more chained calls.

# Front-end code

- Front-end assets are built via Vite (`npm run build`), the source modules live in the `frontend/` directory.
- We're not consistently using CommonJS yet (only in the editor module). This should change to make the codebase more manageable.
- We try to keep globals to a minimum. There's a couple global objects we do use:
  - `window.config` stores exported settings and UI messages from the application specific for the current user and page.
  - `window.libreviews` mostly contains progressive enhancement features that may need to be repeatedly applied if the page changes.
    - `window.libreviews.activeRTEs` holds access to the rich-text
