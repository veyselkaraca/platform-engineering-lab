import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { AuthedRequest, IS_PUBLIC, ROLES } from './auth.decorators';
import { RejectReason, TokenInvalid, TokenVerifier } from './token-verifier';

// Global guard: authenticates every route except @Public(), then applies @Roles(). Deny by default.
// The client always gets the same generic message; the specific reason is only logged. Tokens are never logged.
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly log = new Logger('auth');

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const requestId = String(req.id ?? req.headers['x-request-id'] ?? 'unknown');

    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!match) return this.unauthorized(res, requestId, 'missing');

    try {
      req.principal = await this.verifier.verify(match[1]);
    } catch (err) {
      if (err instanceof TokenInvalid) return this.unauthorized(res, requestId, err.reason);
      this.log.error(`auth.keys_unavailable requestId=${requestId} cause=${(err as Error).message}`);
      throw new ServiceUnavailableException('Authentication is temporarily unavailable');
    }

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES, targets);
    if (roles && !roles.some((r) => req.principal!.roles.includes(r))) {
      this.log.warn(`auth.forbidden requestId=${requestId} sub=${req.principal.sub} reason=role route=${req.method} ${req.route?.path ?? req.path}`);
      throw new ForbiddenException('Forbidden');
    }
    return true;
  }

  private unauthorized(res: Response, requestId: string, reason: RejectReason): never {
    this.log.warn(`auth.rejected requestId=${requestId} reason=${reason}`);
    res.setHeader('www-authenticate', 'Bearer');
    throw new UnauthorizedException('Invalid or missing token');
  }
}
