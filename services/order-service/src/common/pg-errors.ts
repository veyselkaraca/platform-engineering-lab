import { QueryFailedError } from 'typeorm';

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string })?.code === '23505';
}
