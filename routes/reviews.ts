import config from 'config';
import BlogPost, { type BlogPostInstance } from '../models/blog-post.ts';
import Review from '../models/review.ts';
import Team from '../models/team.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import reviewHandlers from './handlers/review-handlers.ts';
import ReviewProvider from './handlers/review-provider.ts';
import feeds from './helpers/feeds.ts';
import render from './helpers/render.ts';

type ReviewsRouteRequest = HandlerRequest;
type ReviewsRouteResponse = HandlerResponse;

const routes = ReviewProvider.getDefaultRoutes('review');

routes.addFromThing = {
  path: '/new/review/:id',
  methods: ['GET', 'POST'],
};

routes.addFromTeam = {
  path: '/team/:id/new/review',
  methods: ['GET', 'POST'],
};

const router = ReviewProvider.bakeRoutes(null, routes);

// Additional routes

// We show two query results on the front-page, the team developers blog
// and a feed of recent reviews, filtered to include only trusted ones.
router.get('/', async (req: ReviewsRouteRequest, res: ReviewsRouteResponse, next: HandlerNext) => {
  const feedPromise = Review.getFeed({
    onlyTrusted: true,
    withThing: true,
    withTeams: true,
  });
  const sampleTeamsPromise = Team.filterWhere({}).sample(3);
  const blogPromise = config.frontPageTeamBlog
    ? BlogPost.getMostRecentBlogPostsBySlug(config.frontPageTeamBlog, { limit: 3 })
    : Promise.resolve<{ blogPosts: BlogPostInstance[]; offsetDate?: Date } | undefined>(undefined);

  try {
    const [feedResult, sampleTeams, blogResult] = await Promise.all([
      feedPromise,
      sampleTeamsPromise,
      blogPromise,
    ]);

    const feedItems = feedResult.feedItems;
    const offsetDate = feedResult.offsetDate;
    const blogPosts = blogResult?.blogPosts;
    const blogPostsOffsetDate = blogResult?.offsetDate;

    // Set review permissions
    feedItems.forEach(item => {
      item.populateUserInfo(req.user);
      const reviewThing = item.thing as
        | { populateUserInfo?: (user: HandlerRequest['user']) => void }
        | undefined;
      if (reviewThing && typeof reviewThing.populateUserInfo === 'function') {
        reviewThing.populateUserInfo(req.user);
      }

      // Compute isLongReview flag for collapsible pattern
      const htmlContent = item.html?.[item.originalLanguage || 'en'] || '';
      item.isLongReview = htmlContent.length > 500;
    });

    // Set post permissions
    if (blogPosts) blogPosts.forEach(post => post.populateUserInfo(req.user));

    let embeddedFeeds = feeds.getEmbeddedFeeds(req, {
      atomURLPrefix: '/feed/atom',
      atomURLTitleKey: 'atom feed of all reviews',
    });

    if (config.frontPageTeamBlog)
      embeddedFeeds = embeddedFeeds.concat(
        feeds.getEmbeddedFeeds(req, {
          atomURLPrefix: `/team/${config.frontPageTeamBlog}/blog/atom`,
          atomURLTitleKey: config.frontPageTeamBlogKey,
        })
      );

    let paginationURL;
    if (offsetDate) paginationURL = `/feed/before/${offsetDate.toISOString()}`;

    render.template(req, res, 'index', {
      titleKey: 'welcome',
      deferPageHeader: true,
      feedItems,
      blogPosts,
      blogKey: config.frontPageTeamBlogKey,
      showBlog: !!config.frontPageTeamBlog,
      team: config.frontPageTeamBlog
        ? {
            id: config.frontPageTeamBlog,
          }
        : undefined,
      paginationURL,
      sampleTeams,
      blogPostsUTCISODate: blogPostsOffsetDate ? blogPostsOffsetDate.toISOString() : undefined,
      embeddedFeeds,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/feed', reviewHandlers.getFeedHandler({ deferPageHeader: true }));

router.get('/feed/atom', (req: ReviewsRouteRequest, res: ReviewsRouteResponse) =>
  res.redirect(`/feed/atom/${req.locale}`)
);

router.get(
  '/feed/atom/:language',
  reviewHandlers.getFeedHandler({
    format: 'atom',
  })
);

router.get('/feed/before/:utcisodate', reviewHandlers.getFeedHandler({ deferPageHeader: true }));

router.get('/new', (req: ReviewsRouteRequest, res: ReviewsRouteResponse) =>
  res.redirect('/new/review')
);

export default router;
