/** The one place the code asks what time it is, so a recording can pin it. */
let frozen: Date | undefined;

export const now = (): Date => (frozen ? new Date(frozen.getTime()) : new Date());

/** Make every later now() return this instant. Used by record and replay so both issue identical requests. */
export function freezeClock(at: Date): void {
  frozen = at;
}
