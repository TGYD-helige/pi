import type { FilmPrompt, ShotPrompt } from './types.js';

/**
 * Structured prompt assembly.
 *
 * The creative content is authored by the caller (the video-gen skill guides
 * the LLM); this module is the mechanical half — it guarantees that every
 * shot sent to the provider carries the film-level directives (style,
 * consistency, negative) and the shot-level sections in a fixed, labeled
 * order, so prompt structure does not depend on LLM compliance at call time.
 */

/** Serialize film + shot fields into the labeled prompt text sent to providers. */
export function assemblePrompt(film: FilmPrompt, shot: ShotPrompt): string {
  const sections: string[] = [];
  if (film.style) sections.push(`[Style] ${film.style}`);
  for (const id of shot.visibleCharacters ?? []) {
    const character = film.characters?.find((c) => c.id === id);
    if (character) sections.push(`[Character] ${character.id}: ${character.description}`);
  }
  if (shot.scene) sections.push(`[Scene] ${shot.scene}`);
  sections.push(`[Visuals] ${shot.visuals}`);
  sections.push(`[Action] ${shot.action}`);
  if (shot.effects) sections.push(`[Effects] ${shot.effects}`);
  if (shot.audio) sections.push(`[Audio] ${shot.audio}`);
  if (film.consistency) sections.push(film.consistency);
  if (film.negative) sections.push(`Negative: ${film.negative}`);
  return sections.join('\n');
}

/**
 * Validate structured prompt fields; returns a user-facing message or null.
 * `where` prefixes the message (e.g. `shots[2] ("s3").prompt`).
 *
 * Rules: visuals + action are always required; a shot without a first frame
 * is text-to-video, so style and scene become required — the frameless path
 * must not go out with action-only prompts.
 */
export function validateShotPrompt(
  film: FilmPrompt,
  /** Untrusted at the JSON boundary — may be absent (e.g. a jobId-only resume call). */
  shot: ShotPrompt | undefined,
  opts: { hasFirstFrame: boolean },
  where: string,
): string | null {
  if (!shot || typeof shot !== 'object') {
    return `${where} must be an object with visuals/action (plus scene/effects/audio/visibleCharacters).`;
  }
  if (typeof shot.visuals !== 'string' || shot.visuals.trim() === '') {
    return `${where}.visuals is required (camera, framing, composition).`;
  }
  if (typeof shot.action !== 'string' || shot.action.trim() === '') {
    return `${where}.action is required (in-frame action/movement).`;
  }
  // Optional fields are type-checked too — render-input.json is hand/agent-written
  // JSON with no schema gate, and a non-string would serialize into the paid
  // prompt as "[object Object]".
  for (const key of ['scene', 'effects', 'audio'] as const) {
    const value = shot[key];
    if (value !== undefined && typeof value !== 'string') {
      return `${where}.${key} must be a string.`;
    }
  }
  if (!opts.hasFirstFrame) {
    if (typeof film.style !== 'string' || film.style.trim() === '') {
      return `${where} has no first frame — film-level "style" is required for text-to-video (genre/quality anchors, e.g. "cinematic, 8K, film grain").`;
    }
    if (typeof shot.scene !== 'string' || shot.scene.trim() === '') {
      return `${where}.scene is required when no first frame anchors the visuals.`;
    }
  }
  if (
    shot.visibleCharacters !== undefined &&
    (!Array.isArray(shot.visibleCharacters) ||
      shot.visibleCharacters.some((id) => typeof id !== 'string'))
  ) {
    return `${where}.visibleCharacters must be an array of character ids (strings).`;
  }
  for (const id of shot.visibleCharacters ?? []) {
    if (!film.characters?.some((c) => c.id === id)) {
      return `${where}.visibleCharacters references unknown character "${id}" — define it in the film-level "characters" array.`;
    }
  }
  return null;
}

/** Validate film-level fields; returns a user-facing message or null. */
export function validateFilmPrompt(film: FilmPrompt, where: string): string | null {
  for (const key of ['style', 'consistency', 'negative'] as const) {
    const value = film[key];
    if (value !== undefined && typeof value !== 'string') {
      return `${where}.${key} must be a string.`;
    }
  }
  if (film.characters === undefined) return null;
  if (!Array.isArray(film.characters)) {
    return `${where}.characters must be an array of {id, description}.`;
  }
  const seen = new Set<string>();
  for (const [i, c] of film.characters.entries()) {
    const at = `${where}.characters[${i}]`;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id.trim() === '') {
      return `${at} must have a non-empty "id".`;
    }
    if (typeof c.description !== 'string' || c.description.trim() === '') {
      return `${at} ("${c.id}") must have a non-empty "description" (appearance + outfit).`;
    }
    if (seen.has(c.id)) {
      return `${at} duplicates character id "${c.id}".`;
    }
    seen.add(c.id);
  }
  return null;
}
