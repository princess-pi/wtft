/** Succeeded, but the printed total may still grow (distinct from exit 1 = failed). */
export const EXIT_PROVISIONAL = 9;

/** No interactive terminal: no `-s`, or `-s` did not match exactly one session. */
export const EXIT_SESSION_AMBIGUOUS = 10;
