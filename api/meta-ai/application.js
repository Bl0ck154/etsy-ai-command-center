export function createMetaAiApplication({
  buildCookieHeader,
  getMetaAiCookieHeader,
  getMetaAiSession,
  getSafeMetaAiStatus,
  probeMetaAiGateway,
  generateMetaAiVideo,
} = {}) {
  async function resolveCookieHeader(input = {}) {
    return buildCookieHeader(input.cookieHeader || input.cookies) || await getMetaAiCookieHeader();
  }

  async function execute(action, input = {}) {
    let activeCookieHeader = '';
    try {
      if (action === 'status') {
        activeCookieHeader = await resolveCookieHeader(input);
        const data = await getSafeMetaAiStatus({ cookieHeader: activeCookieHeader });
        return { kind: 'status', data };
      }

      if (action === 'probeGateway') {
        activeCookieHeader = await resolveCookieHeader(input);
        const session = await getMetaAiSession({ cookieHeader: activeCookieHeader });
        const data = await probeMetaAiGateway({ accessToken: session.accessToken });
        return { kind: 'probe', data };
      }

      if (action === 'generateVideo' || action === 'animateImage') {
        if (action === 'animateImage' && !input.referenceImage && !input.imageUrl && !input.imagePath) {
          const error = new Error('referenceImage, imageUrl, or imagePath required');
          error.status = 400;
          throw error;
        }
        activeCookieHeader = await resolveCookieHeader(input);
        const video = await generateMetaAiVideo({ ...input, cookieHeader: activeCookieHeader });
        return { kind: 'video', video };
      }

      const error = new Error(`Unknown action: ${action}`);
      error.status = 400;
      throw error;
    } catch (error) {
      if (activeCookieHeader) error.metaAiCookieHeader = activeCookieHeader;
      throw error;
    }
  }

  return { resolveCookieHeader, execute };
}
