import config from 'config';

import render from './helpers/render.ts';
import feeds from './helpers/feeds.ts';
import Team from '../models/team.ts';
import Review from '../models/review.ts';
import ReviewProvider from './handlers/review-provider.ts';
import reviewHandlers from './handlers/review-handlers.ts';
import BlogPost from '../models/blog-post.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';

type ReviewsRouteRequest = HandlerRequest;
type ReviewsRouteResponse = HandlerResponse;
type ReviewModelType = { getFeed(options?: Record<string, unknown>): Promise<Record<string, any>> };
type TeamModelType = { filterNotStaleOrDeleted(): { sample: (count: number) => Promise<any> } };
type BlogPostModelType = {
  getMostRecentBlogPostsBySlug(
    slug: string,
    options?: Record<string, unknown>
  ): Promise<Record<string, any>>;
};

const routes = ReviewProvider.getDefaultRoutes('review');
const ReviewModel = Review as unknown as ReviewModelType;
const TeamModel = Team as unknown as TeamModelType;
const BlogPostModel = BlogPost as unknown as BlogPostModelType;

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
  const queries = [
    ReviewModel.getFeed({ onlyTrusted: true, withThing: true, withTeams: true }),
    TeamModel.filterNotStaleOrDeleted().sample(3), // Random example teams
  ];

  if (config.frontPageTeamBlog) {
    queries.push(
      BlogPostModel.getMostRecentBlogPostsBySlug(config.frontPageTeamBlog, { limit: 3 })
    );
  }

  try {
    const queryResults = await Promise.all(queries);

    // Promise.all keeps order in which promises were passed
    const feedItems = queryResults[0].feedItems;
    const offsetDate = queryResults[0].offsetDate;
    const sampleTeams = queryResults[1]; // ignored if undefined
    const blogPosts = config.frontPageTeamBlog ? queryResults[2].blogPosts : undefined;
    const blogPostsOffsetDate = config.frontPageTeamBlog ? queryResults[2].offsetDate : undefined;

    // Set review permissions
    feedItems.forEach(item => {
      item.populateUserInfo(req.user);
      if (item.thing) item.thing.populateUserInfo(req.user);
    });

    // Set post permissions
    if (blogPosts) blogPosts.forEach(post => post.populateUserInfo(req.user));

    let embeddedFeeds = feeds.getEmbeddedFeeds(req, {
      atomURLPrefix: `/feed/atom`,
      atomURLTitleKey: `atom feed of all reviews`,
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
      showBlog: config.frontPageTeamBlog ? true : false,
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
