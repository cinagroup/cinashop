import { AttachmentService, userAttachmentScope } from '@/services/system/AttachmentService';
import { diyPageSettingsFixture } from './diyPageSettingsFixture';

/** Existing owned73/68 schema and authenticated Admin role; every extra object
 * is uploaded by its real service, not inserted as fabricated attachment data. */
export async function diyMediaReferenceFixture(now = new Date()) {
  const f = await diyPageSettingsFixture(now);
  try {
    const before = await f.snapshot(), resourcesBefore = f.resources();
    const service = new AttachmentService(f.container, f.env);
    const foreignImage = await service.uploadImage(userAttachmentScope(22), new File([f.png], 'foreign-private.png', { type: 'image/png' }), 0);
    const privateVideo = await service.uploadUserVideo(11, f.file());
    return { ...f, foreignImage, privateVideo,
      mediaReferenceSetup: { phase: 'owned setup: real user22 PNG and user11 MP4 uploads; never public-read work',
        before, after: await f.snapshot(), resources_before: resourcesBefore, resources_after: f.resources(),
        private_image: f.image, foreign_image: foreignImage, private_video: privateVideo } };
  } catch (reason) { await f.close(); throw reason; }
}
