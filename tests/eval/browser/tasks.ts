export const DEFAULT_BROWSER_TOOLS =
  'browser_navigate_page,browser_take_snapshot,browser_click,browser_fill,browser_fill_form,browser_press_key,browser_wait_for';

export interface BrowserTask {
  id: string;
  startUrl: string;
  instruction: string;
  tools?: string;
  check: (ctx: { answer: string; observed: string }) => boolean;
  gold: string;
}

export const BROWSER_TASKS: Omit<BrowserTask, 'check'>[] = [
  {
    id: 'example-title',
    startUrl: '/',
    instruction: 'Report the exact main heading.',
    gold: 'Example Domain',
  },
  {
    id: 'example-link-text',
    startUrl: '/',
    instruction: 'Report the exact visible text of the link to the article.',
    gold: 'Learn more',
  },
  {
    id: 'example-org-title',
    startUrl: '/alternate',
    instruction: 'Report the exact main heading.',
    gold: 'Second Domain',
  },
  {
    id: 'login-form-submit',
    startUrl: '/login',
    instruction:
      'Log in using the supplied credentials. Report the exact heading of the resulting page.',
    gold: 'Secure Area',
  },
  {
    id: 'article-first-sentence',
    startUrl: '/article',
    instruction: 'Read the article and report what kind of application a web browser is.',
    gold: 'application for accessing websites',
  },
  {
    id: 'multi-step-navigate',
    startUrl: '/',
    instruction:
      'Click the A/B Testing link. Report the exact main heading on the destination page.',
    gold: 'A/B Test',
  },
  {
    id: 'form-save',
    startUrl: '/editor',
    instruction:
      'Replace the note with the supplied new value and save it. Report the saved value.',
    gold: 'Saved',
  },
  {
    id: 'form-cancel',
    startUrl: '/editor',
    instruction:
      'Replace the note with the supplied new value, then cancel without saving. Report the original value that remains saved.',
    gold: 'Original',
  },
];
