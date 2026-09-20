import { query } from './db';

export function countRows(table: string): number {
  return query(`select * from ${table}`);
}
