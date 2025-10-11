*Please also see the [code of conduct](https://github.com/eloquence/lib.reviews/blob/master/CODE_OF_CONDUCT.md).*

Thanks for taking a look! If you just want to write reviews, please see the [instructions for getting an account](https://lib.reviews/register). For technical/design contributions, read on.

We welcome contributions to [any of our open issues](https://github.com/eloquence/lib.reviews/issues), as well as new ideas. Issues tagged as "[good for new contributors](https://github.com/eloquence/lib.reviews/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+for+new+contributors%22)" don't require in-depth knowledge of the whole codebase. We're happy to set aside time for personal coaching in the codebase (e.g., via video-conference/screen-sharing). Ping `Eloquence` on `#lib.reviews` (irc.libera.chat) to get started.

# Technical overview

lib.reviews is a pure-JavaScript application, using modern language features where appropriate. Here are some of the specific technical choices we've made.

| Technology                               | Current use                              |
| ---------------------------------------- | ---------------------------------------- |
| [Node.js](https://nodejs.org/en/) 22.x (current release line) | lib.reviews server, API and tests        |
| [Express](https://expressjs.com/) (V4 series) | Framework for the web application        |
| [RethinkDB](https://rethinkdb.com/)      | Primary storage backend for text. (This may need to change in the long-run since RethinkDB no longer has a commercial parent and development has slowed down.) |
| [ElasticSearch](https://www.elastic.co/) | Search backend                           |
| [Thinky](http://thinky.io/)              | Object Document Mapper for modeling the data stored in RethinkDB |
| [Handlebars](http://handlebarsjs.com/)   | Front-end templates (currently only rendered server-side) |
| [LESS](http://lesscss.org/)              | CSS pre-processor, makes CSS easier to use |
| [PureCSS](https://purecss.io/)           | Grid system and basic styles             |
| [Grunt](https://gruntjs.com/)            | Build pipeline for front-end assets. (Moving to another pipeline is worth investigating primarily for performance benefits.) |
| [Babel](https://babeljs.io/)             | Transpilation of front-end code that includes ES6 Javascript language features; transpilation of tests that include ES7 features |
| [ava](https://github.com/avajs/ava)      | Asynchronous test runner                 |
| [pm2](http://pm2.keymetrics.io/)         | Process management, monitoring, deployment |
| [ProseMirror](http://prosemirror.net/)   | Rich-text editor                         |
| [jQuery](https://jquery.com/)            | DOM manipulation                         |

This project follows a strong philosophy of progressive enhancement. That means that client-side UI features should always be optional, not required -- the primary functionality of the site should be available without JavaScript and on low-end devices.

We also try to add keyboard shortcuts where relevant, and generally follow existing conventions for those (from Wikipedia, Google and other sites).

We aim to be multilingual in UI and content, and are exclusively using translatable strings throughout the user interface.

# Getting started

This is very much an open project and we'd love your help! :) To get started, clone the repository to your local computer. You will need Node.js 22.x (the current release line we target). Switch to your check-out directory and then run `npm install`. Run `grunt` to build the JavaScript. Make sure you also have RethinkDB up and running before starting the service.

You can customize your development configuration by copying `config/default.json5` to `config/development.json5`. Finally, run `npm run start-dev` and visit `localhost` at the configured port number.

The startup scripts use [pm2](https://www.npmjs.com/package/pm2), which you can safely install globally alongside the local version. It's a handy tool that keeps the process running in the background, balances it across multiple cores if available, lets you manage log files, etc. If for any reason you just want to run the server without pm2, you can always fire up `node bin/www` instead.

Any pull requests must be under the [CC-0 License](./LICENSE). This project has adopted a [code of conduct](./CODE_OF_CONDUCT.md) to make sure all contributors feel welcome.

# Using Vagrant

*The Vagrant setup is experimental and in need of some maintenance love.*

If you're familiar with Vagrant and VirtualBox, you may find it easier to configure a working environment using our Vagrantfile. To install using Vagrant, simply type

`vagrant up`

in the main directory, and follow the instructions printed on screen. All dependencies will be installed automatically within a virtualized Debian environment.

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

- We use [eslint](http://eslint.org/)  with the [babel-eslint](https://github.com/babel/babel-eslint) package for automatic code linting, using the [.eslintrc](https://github.com/eloquence/lib.reviews/blob/master/.eslintrc.json) that's checked into the repository. This defines most of our other assumptions.

- Semicolons are nice. They help to navigate multi-line statements like this:

  ````javascript
  if (true)
    Promise.resolve()
    	.then(() => console.log('Done'))
    	.catch(() => console.log('Oh no'));
  ````

- Break chains for readability at about ~3 or more chained calls.

# Front-end code

- Front-end assets are built via `grunt`, the JS source code lives in the `frontend/` directory.
- We're not consistently using CommonJS yet (only in the editor module). This should change to make the codebase more manageable.
- We try to keep globals to a minimum. There's a couple global objects we do use:
  - `window.config` stores exported settings and UI messages from the application specific for the current user and page.
  - `window.libreviews` mostly contains progressive enhancement features that may need to be repeatedly applied if the page changes.
    - `window.libreviews.activeRTEs` holds access to the rich-text
