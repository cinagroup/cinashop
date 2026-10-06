import {
  AdminActivityFrameService, BACKGROUND_KIND, type DecorativePromotionKind,
} from './AdminActivityFrameService';

/** The public service identity is fixed here; callers cannot choose promotions_type. */
export class AdminActivityBackgroundService extends AdminActivityFrameService {
  protected override get promotionKind(): DecorativePromotionKind { return BACKGROUND_KIND; }
}
