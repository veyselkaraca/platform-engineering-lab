import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
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
