import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Env } from '../config/env';
import { AuthGuard } from './auth.guard';
import { remoteKeys, TokenVerifier } from './token-verifier';

@Module({
  providers: [
    {
      provide: TokenVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new TokenVerifier(
          remoteKeys(config.get('AUTH_JWKS_URL'), config.get('AUTH_JWKS_TIMEOUT_MS'), config.get('AUTH_JWKS_CACHE_SECONDS')),
          {
            issuer: config.get('AUTH_ISSUER'),
            audience: config.get('AUTH_AUDIENCE'),
            clockToleranceSeconds: config.get('AUTH_CLOCK_TOLERANCE_SECONDS'),
          },
        ),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokenVerifier],
})
export class AuthModule {}
