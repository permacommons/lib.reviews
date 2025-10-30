'use strict';

// External dependencies
const config = require('config');

// Internal dependencies
const render = require('./helpers/render');
const feeds = require('./helpers/feeds');
const Team = require('../models/team');
const Review = require('../models/review');
const ReviewProvider = require('./handlers/review-provider');
const reviewHandlers = require('./handlers/review-handlers');
const BlogPost = require('../models/blog-post');

// Standard routes

let routes = ReviewProvider.getDefaultRoutes('review');

routes.addFromThing = {
  path: '/new/review/:id',
  methods: ['GET', 'POST']
};

routes.addFromTeam = {
  path: '/team/:id/new/review',
  methods: ['GET', 'POST']
};

let router = ReviewProvider.bakeRoutes(null, routes);

// Additional routes

// We show two query results on the front-page, the team developers blog
// and a feed of recent reviews, filtered to include only trusted ones.
router.get('/', async (req, res, next) => {

  // Models are now available directly via bootstrap initialization
  let queries = [
    Review.getFeed({ onlyTrusted: true, withThing: true, withTeams: true }),
    Team.filterNotStaleOrDeleted().sample(3) // Random example teams
  ];

  if (config.frontPageTeamBlog) {
    queries.push(BlogPost.getMostRecentBlogPostsBySlug(
      config.frontPageTeamBlog, { limit: 3 }
    ));
  }

  Promise
    .all(queries)
    .then(queryResults => {

      // Promise.all helpfully keeps order in which promises were passed
      let feedItems = queryResults[0].feedItems;
      let offsetDate = queryResults[0].offsetDate;
      let sampleTeams = queryResults[1]; // will be ignored if undefined
      let blogPosts = config.frontPageTeamBlog ? queryResults[2].blogPosts : undefined;
      let blogPostsOffsetDate = config.frontPageTeamBlog ? queryResults[2].offsetDate : undefined;

      // Set review permissions
      feedItems.forEach(item => {
        item.populateUserInfo(req.user);
        if (item.thing)
          item.thing.populateUserInfo(req.user);
      });

      // Set post permissions
      if (blogPosts)
        blogPosts.forEach(post => post.populateUserInfo(req.user));

      let embeddedFeeds = feeds.getEmbeddedFeeds(req, {
        atomURLPrefix: `/feed/atom`,
        atomURLTitleKey: `atom feed of all reviews`,
      });

      if (config.frontPageTeamBlog)
        embeddedFeeds = embeddedFeeds.concat(feeds.getEmbeddedFeeds(req, {
          atomURLPrefix: `/team/${config.frontPageTeamBlog}/blog/atom`,
          atomURLTitleKey: config.frontPageTeamBlogKey
        }));

      let paginationURL;
      if (offsetDate)
        paginationURL = `/feed/before/${offsetDate.toISOString()}`;

      render.template(req, res, 'index', {
        titleKey: 'welcome',
        deferPageHeader: true,
        feedItems,
        blogPosts,
        blogKey: config.frontPageTeamBlogKey,
        showBlog: config.frontPageTeamBlog ? true : false,
        team: config.frontPageTeamBlog ? {
          id: config.frontPageTeamBlog
        } : undefined,
        paginationURL,
        sampleTeams,
        blogPostsUTCISODate: blogPostsOffsetDate ? blogPostsOffsetDate.toISOString() : undefined,
        embeddedFeeds
      });
    })
    .catch(next);

});


router.get('/feed', reviewHandlers.getFeedHandler({ deferPageHeader: true }));

router.get('/feed/atom', (req, res) => res.redirect(`/feed/atom/${req.locale}`));

router.get('/feed/atom/:language', reviewHandlers.getFeedHandler({
  format: 'atom'
}));

router.get('/feed/before/:utcisodate', reviewHandlers.getFeedHandler({ deferPageHeader: true }));

router.get('/new', (req, res) => res.redirect('/new/review'));

module.exports = router;
