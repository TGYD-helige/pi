import { describe, expect, it } from 'vitest';
import { assemblePrompt, validateFilmPrompt, validateShotPrompt } from '../prompt.js';

describe('assemblePrompt', () => {
  it('assembles all sections in the fixed labeled order', () => {
    const text = assemblePrompt(
      {
        style: 'cinematic, 8K, film grain',
        characters: [
          { id: 'alice', description: 'long blonde hair, red scarf' },
          { id: 'bob', description: 'tall, black coat' },
        ],
        consistency: 'Faces and outfits stay identical, no morphing.',
        negative: 'no text, watermarks, or subtitles',
      },
      {
        scene: 'rainy alley at night',
        visuals: 'Slow push-in, medium close-up',
        action: 'Alice walks in from the left',
        effects: 'rain picks up, neon reflections intensify',
        audio: '[Sound Effect] rain, distant traffic',
        visibleCharacters: ['alice'],
      },
    );
    expect(text).toBe(
      [
        '[Style] cinematic, 8K, film grain',
        '[Character] alice: long blonde hair, red scarf',
        '[Scene] rainy alley at night',
        '[Visuals] Slow push-in, medium close-up',
        '[Action] Alice walks in from the left',
        '[Effects] rain picks up, neon reflections intensify',
        '[Audio] [Sound Effect] rain, distant traffic',
        'Faces and outfits stay identical, no morphing.',
        'Negative: no text, watermarks, or subtitles',
      ].join('\n'),
    );
  });

  it('omits absent optional sections and non-visible characters', () => {
    const text = assemblePrompt(
      {
        style: 'cinematic',
        characters: [{ id: 'bob', description: 'tall, black coat' }],
      },
      { visuals: 'static wide', action: 'waves rolling' },
    );
    expect(text).toBe('[Style] cinematic\n[Visuals] static wide\n[Action] waves rolling');
  });

  it('skips visibleCharacters ids missing from the registry (validation rejects them earlier)', () => {
    const text = assemblePrompt(
      { characters: [{ id: 'alice', description: 'red scarf' }] },
      { visuals: 'v', action: 'a', visibleCharacters: ['ghost'] },
    );
    expect(text).toBe('[Visuals] v\n[Action] a');
  });
});

describe('validateShotPrompt', () => {
  const film = { style: 'cinematic', characters: [{ id: 'alice', description: 'red scarf' }] };

  it('requires visuals and action', () => {
    expect(
      validateShotPrompt(film, { visuals: '', action: 'a' }, { hasFirstFrame: true }, 'prompt'),
    ).toMatch(/visuals is required/);
    expect(
      validateShotPrompt(film, { visuals: 'v', action: '  ' }, { hasFirstFrame: true }, 'prompt'),
    ).toMatch(/action is required/);
  });

  it('rejects a non-object prompt', () => {
    expect(
      validateShotPrompt(film, 'freeform' as never, { hasFirstFrame: true }, 'prompt'),
    ).toMatch(/must be an object/);
  });

  it('requires style and scene when no first frame anchors the shot', () => {
    expect(
      validateShotPrompt(
        { characters: film.characters },
        { visuals: 'v', action: 'a', scene: 's' },
        { hasFirstFrame: false },
        'prompt',
      ),
    ).toMatch(/style.*required for text-to-video/);
    expect(
      validateShotPrompt(
        film,
        { visuals: 'v', action: 'a' },
        { hasFirstFrame: false },
        'shots[0].prompt',
      ),
    ).toMatch(/scene is required when no first frame/);
  });

  it('accepts a frame-anchored shot without style/scene', () => {
    expect(
      validateShotPrompt({}, { visuals: 'v', action: 'a' }, { hasFirstFrame: true }, 'prompt'),
    ).toBeNull();
  });

  it('rejects visibleCharacters ids missing from the film registry', () => {
    expect(
      validateShotPrompt(
        film,
        { visuals: 'v', action: 'a', visibleCharacters: ['bob'] },
        { hasFirstFrame: true },
        'prompt',
      ),
    ).toMatch(/unknown character "bob"/);
  });

  it('rejects non-string optional fields instead of serializing them into the prompt', () => {
    expect(
      validateShotPrompt(
        film,
        { visuals: 'v', action: 'a', effects: { kind: 'rain' } as never },
        { hasFirstFrame: true },
        'prompt',
      ),
    ).toMatch(/\.effects must be a string/);
    expect(
      validateShotPrompt(
        film,
        { visuals: 'v', action: 'a', audio: 42 as never },
        { hasFirstFrame: true },
        'prompt',
      ),
    ).toMatch(/\.audio must be a string/);
    expect(
      validateShotPrompt(
        film,
        { visuals: 'v', action: 'a', scene: ['x'] as never },
        { hasFirstFrame: true },
        'prompt',
      ),
    ).toMatch(/\.scene must be a string/);
  });

  it('rejects a malformed visibleCharacters array', () => {
    expect(
      validateShotPrompt(
        film,
        { visuals: 'v', action: 'a', visibleCharacters: 'alice' as never },
        { hasFirstFrame: true },
        'prompt',
      ),
    ).toMatch(/visibleCharacters must be an array/);
    expect(
      validateShotPrompt(
        film,
        { visuals: 'v', action: 'a', visibleCharacters: [42] as never },
        { hasFirstFrame: true },
        'prompt',
      ),
    ).toMatch(/visibleCharacters must be an array/);
  });
});

describe('validateFilmPrompt', () => {
  it('accepts an absent registry', () => {
    expect(validateFilmPrompt({}, 'render-input.json')).toBeNull();
  });

  it('rejects malformed entries and duplicate ids', () => {
    expect(validateFilmPrompt({ characters: 'nope' as never }, 'render-input.json')).toMatch(
      /must be an array/,
    );
    expect(
      validateFilmPrompt({ characters: [{ id: '', description: 'd' }] }, 'render-input.json'),
    ).toMatch(/non-empty "id"/);
    expect(
      validateFilmPrompt({ characters: [{ id: 'a', description: ' ' }] }, 'render-input.json'),
    ).toMatch(/non-empty "description"/);
    expect(
      validateFilmPrompt(
        {
          characters: [
            { id: 'a', description: 'd1' },
            { id: 'a', description: 'd2' },
          ],
        },
        'render-input.json',
      ),
    ).toMatch(/duplicates character id "a"/);
  });

  it('rejects non-string film-level scalar fields', () => {
    expect(validateFilmPrompt({ style: 8 as never }, 'render-input.json')).toMatch(
      /\.style must be a string/,
    );
    expect(validateFilmPrompt({ consistency: {} as never }, 'render-input.json')).toMatch(
      /\.consistency must be a string/,
    );
    expect(validateFilmPrompt({ negative: ['x'] as never }, 'render-input.json')).toMatch(
      /\.negative must be a string/,
    );
  });
});
