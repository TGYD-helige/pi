import { describe, expect, it } from 'vitest';
import { startBrowserFixture } from '../../browser/fixture.js';

describe('browser task environment', () => {
  it('requires a real valid form submission before passing login', async () => {
    const fixture = await startBrowserFixture();
    try {
      const task = fixture.tasks.find((task) => task.id === 'login-form-submit')!;
      const answer = task.gold.toLowerCase();
      expect(task.check!({ answer, observed: answer })).toBe(false);
      await fetch(`${fixture.url}/login`, {
        method: 'POST',
        body: new URLSearchParams({ username: 'wrong', password: 'wrong' }),
      });
      expect(task.check!({ answer, observed: answer })).toBe(false);
      await fetch(`${fixture.url}/login`, {
        method: 'POST',
        body: new URLSearchParams({ username: fixture.username, password: fixture.password }),
      });
      expect(task.check!({ answer, observed: answer })).toBe(true);
    } finally {
      await fixture.close();
    }
  });
  it('checks the persisted value for save and cancel rather than trusting the answer', async () => {
    const fixture = await startBrowserFixture();
    try {
      const save = fixture.tasks.find((task) => task.id === 'form-save')!;
      const cancel = fixture.tasks.find((task) => task.id === 'form-cancel')!;
      await fetch(`${fixture.url}/saved`);
      expect(save.check({ answer: save.gold, observed: save.gold })).toBe(false);
      expect(cancel.check({ answer: cancel.gold, observed: '' })).toBe(false);
      await fetch(`${fixture.url}/save`, {
        method: 'POST',
        body: new URLSearchParams({ note: save.gold }),
      });
      expect(save.check({ answer: save.gold, observed: '' })).toBe(true);
      expect(cancel.check({ answer: cancel.gold, observed: cancel.gold })).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('does not pass from a link label or a stale trial value', async () => {
    const first = await startBrowserFixture();
    const second = await startBrowserFixture();
    try {
      const before = first.tasks.find((task) => task.id === 'multi-step-navigate')!;
      const after = second.tasks.find((task) => task.id === 'multi-step-navigate')!;
      await fetch(second.url);
      expect(after.check({ answer: after.gold, observed: 'A/B Testing' })).toBe(false);
      await fetch(`${second.url}/ab`);
      expect(after.check({ answer: before.gold, observed: '' })).toBe(false);
      expect(after.check({ answer: after.gold, observed: '' })).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('accepts extra verification after a successful cancellation', async () => {
    const fixture = await startBrowserFixture();
    try {
      const task = fixture.tasks.find((task) => task.id === 'form-cancel')!;
      const replacement = fixture.tasks.find((task) => task.id === 'form-save')!.gold;
      await fetch(`${fixture.url}/cancel`, {
        method: 'POST',
        body: new URLSearchParams({ note: replacement }),
      });
      await fetch(`${fixture.url}/editor`);
      expect(task.check({ answer: task.gold, observed: '' })).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('shows the persisted note when the editor is reopened after saving', async () => {
    const fixture = await startBrowserFixture();
    try {
      const task = fixture.tasks.find((task) => task.id === 'form-save')!;
      await fetch(`${fixture.url}/save`, {
        method: 'POST',
        body: new URLSearchParams({ note: task.gold }),
      });
      const html = await (await fetch(`${fixture.url}/editor`)).text();
      expect(html).toContain(`value="${task.gold}"`);
    } finally {
      await fixture.close();
    }
  });
  it('requires cancelling the edited value without persisting it', async () => {
    const fixture = await startBrowserFixture();
    try {
      const task = fixture.tasks.find((task) => task.id === 'form-cancel')!;
      const replacement = fixture.tasks.find((task) => task.id === 'form-save')!.gold;
      await fetch(`${fixture.url}/saved`);
      expect(task.check({ answer: task.gold, observed: '' })).toBe(false);
      await fetch(`${fixture.url}/cancel`, {
        method: 'POST',
        body: new URLSearchParams({ note: task.gold }),
      });
      expect(task.check({ answer: task.gold, observed: '' })).toBe(false);
      await fetch(`${fixture.url}/cancel`, {
        method: 'POST',
        body: new URLSearchParams({ note: replacement }),
      });
      expect(task.check({ answer: task.gold, observed: '' })).toBe(true);
      expect(fixture.state().saved).toBe(task.gold);
    } finally {
      await fixture.close();
    }
  });
});
