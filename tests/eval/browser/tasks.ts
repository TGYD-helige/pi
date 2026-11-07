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

// Fixture-specific checks additionally verify server state and a fresh per-trial value.
const answerIncludes =
  (text: string) =>
  ({ answer }: { answer: string; observed: string }) =>
    answer.toLowerCase().includes(text.toLowerCase());

export const BROWSER_TASKS: BrowserTask[] = [
  {
    id: 'example-title',
    startUrl: '/',
    instruction: 'Report the exact main heading.',
    gold: 'Example Domain',
    check: answerIncludes('example domain'),
  },
  {
    id: 'example-link-text',
    startUrl: '/',
    instruction: 'Report the exact visible text of the link to the article.',
    gold: 'Learn more',
    check: answerIncludes('learn more'),
  },
  {
    id: 'example-org-title',
    startUrl: '/alternate',
    instruction: 'Report the exact main heading.',
    gold: 'Second Domain',
    check: answerIncludes('second domain'),
  },
  {
    id: 'login-form-submit',
    startUrl: '/login',
    instruction:
      'Log in using the supplied credentials. Report the exact heading of the resulting page.',
    gold: 'Secure Area',
    check: answerIncludes('secure area'),
  },
  {
    id: 'article-first-sentence',
    startUrl: '/article',
    instruction: 'Read the article and report what kind of application a web browser is.',
    gold: 'application for accessing websites',
    check: answerIncludes('application for accessing websites'),
  },
  {
    id: 'multi-step-navigate',
    startUrl: '/',
    instruction:
      'Click the A/B Testing link. Report the exact main heading on the destination page.',
    gold: 'A/B Test',
    check: answerIncludes('a/b test'),
  },
  {
    id: 'form-save',
    startUrl: '/editor',
    instruction:
      'Replace the note with the supplied new value and save it. Report the saved value.',
    gold: 'Saved',
    check: answerIncludes('saved'),
  },
  {
    id: 'form-cancel',
    startUrl: '/editor',
    instruction:
      'Replace the note with the supplied new value, then cancel without saving. Report the original value that remains saved.',
    gold: 'Original',
    check: answerIncludes('original'),
  },
];
