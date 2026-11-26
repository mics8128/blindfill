import { BlindfillError } from '../../../core/types.js';
import type { BrowserProvider } from './types.js';

/** In-process Playwright Page owned by the caller (any browser). Never closed by blindfill. */
export const borrowedPage: BrowserProvider = {
  id: 'borrowed-page',
  title: 'Borrow a Playwright Page held by the caller (library use)',
  attachable: false,
  capabilities: {
    evaluateIsolatedWorld: false,
    cdp: false,
    ownsBrowser: false,
    pagesSurviveDisconnect: true,
  },
  async connect(opts) {
    if (!opts.page)
      throw new BlindfillError('ACTUATOR', 'borrowed-page needs a Playwright Page (options.page)');
    const page = opts.page;
    return {
      page,
      context: page.context(),
      browser: null,
      // unknown for a borrowed page: stay conservative (our scripts never rely on page globals)
      capabilities: borrowedPage.capabilities,
      close: async () => undefined,
    };
  },
};
