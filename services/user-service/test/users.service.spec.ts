import { ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import { User } from '../src/users/user.entity';
import { UsersService } from '../src/users/users.service';

function makeService(repo: Partial<Record<keyof Repository<User>, jest.Mock>>) {
  return new UsersService(repo as unknown as Repository<User>);
}

describe('UsersService', () => {
  it('maps a unique-email violation to 409', async () => {
    const pgError = Object.assign(new Error('duplicate'), { code: '23505' });
    const repo = {
      create: jest.fn((v) => v),
      save: jest.fn().mockRejectedValue(new QueryFailedError('INSERT', [], pgError)),
    };
    await expect(makeService(repo).create({ email: 'a@b.co', name: 'A' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not swallow unexpected errors', async () => {
    const repo = { create: jest.fn((v) => v), save: jest.fn().mockRejectedValue(new Error('boom')) };
    await expect(makeService(repo).create({ email: 'a@b.co', name: 'A' })).rejects.toThrow('boom');
  });

  it('throws 404 for an unknown user', async () => {
    const repo = { findOneBy: jest.fn().mockResolvedValue(null) };
    await expect(makeService(repo).findOne('x')).rejects.toBeInstanceOf(NotFoundException);
  });
});
