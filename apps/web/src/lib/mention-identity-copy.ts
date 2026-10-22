/**
 * A name match sentiment ruled out (`mentionIdentity: wrong-subject`): a short
 * visible label, with the reason in its tooltip. Shared by the Simple answer
 * panel and the Advanced Property evidence, so both say the same thing.
 */
export const DIFFERENT_SUBJECT_COPY = {
  label: 'Different subject',
  project: 'The answer uses your name, but sentiment found it is about something else, so it does not count as a mention.',
  property: 'The answer uses this Property’s name, but sentiment found it is about something else, so it does not count as a mention.',
} as const
