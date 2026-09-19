import { createParamDecorator, ExecutionContext, ForbiddenException, Logger, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { recordAuthRejection } from './auth.metrics';
import { Principal } from './token-verifier';

export const IS_PUBLIC = 'auth:public';
export const ROLES = 'auth:roles';

export type AuthedRequest = Request & { id?: string | number; principal?: Principal };

// Skips authentication (health probes only).
export const Public = () => SetMetadata(IS_PUBLIC, true);
// Any one of the listed roles is enough.
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().principal as Principal;
});

export const isAdmin = (p: Principal) => p.roles.includes('admin');

const log = new Logger('auth');

// The single ownership rule: the token `sub` is the userId (ID-8); admins act for anyone.
// Decided from ids the caller supplied, so a 403 reveals nothing about stored data.
export function assertSelfOrAdmin(principal: Principal, userId: string): void {
  if (isAdmin(principal) || principal.sub === userId.toLowerCase()) return;
  recordAuthRejection('not_owner');
  log.warn(`auth.forbidden sub=${principal.sub} reason=not_owner`);
  throw new ForbiddenException('Forbidden');
}
