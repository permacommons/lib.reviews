import BlogPostProvider from './handlers/blog-post-provider.js';

const router = BlogPostProvider.bakeRoutes(null, {
  browse: {
    path: '/team/:id/blog',
    methods: ['GET']
  },
  browseBefore: {
    path: '/team/:id/blog/before/:utcISODate',
    methods: ['GET']
  },
  browseAtom: {
    path: '/team/:id/blog/atom/:language',
    methods: ['GET']
  },
  browseAtomDetectLanguage: {
    path: '/team/:id/blog/atom',
    methods: ['GET']
  },
  read: {
    path: '/team/:id/post/:postID',
    methods: ['GET']
  },
  add: {
    path: '/team/:id/new/post',
    methods: ['GET', 'POST']
  },
  edit: {
    path: '/team/:id/post/:postID/edit',
    methods: ['GET', 'POST']
  },
  delete: {
    path: '/team/:id/post/:postID/delete',
    methods: ['GET', 'POST']
  }
});

export default router;
