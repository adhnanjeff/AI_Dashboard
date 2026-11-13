import { randomUUID } from 'node:crypto';

export type IdPrefix = 'prj' | 'ses' | 'tsk' | 'run' | 'evt' | 'chk' | 'art' | 'rte' | 'apr' | 'kn' | 'ke' | 'mem' | 'wt' | 'acc' | 'que' | 'hnd';

// Stable, type-prefixed ids: a session id can never be mistaken for a run id in logs or URLs.
export const newId = (prefix: IdPrefix): string => `${prefix}_${randomUUID()}`;
