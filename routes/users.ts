import { Router } from 'express';

import userHandlers from './handlers/user-handlers.ts';

const router = Router();

router.get('/:name', userHandlers.getUserHandler({}));

router.get('/:name/feed', userHandlers.getUserFeedHandler({}));

router.get('/:name/feed/before/:utcisodate', userHandlers.getUserFeedHandler({}));

router.get('/:name/feed/atom/:language', userHandlers.getUserFeedHandler({ format: 'atom' }));

router.get('/:name/edit/bio', userHandlers.getUserHandler({ editBio: true }));

router.post('/:name/edit/bio', userHandlers.processEdit);

export default router;
