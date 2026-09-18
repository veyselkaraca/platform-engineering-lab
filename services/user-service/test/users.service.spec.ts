import { ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import { User } from '../src/users/user.entity';
import { UsersService } from '../src/users/users.service';

function makeService(repo: Partial<Record<keyof Repository<User>, jest.Mock>>) {
  return new UsersService(repo as unknown as Repository<User>);
}

const dto = { id: 'c0ffee00-0000-4000-8000-000000000001', email: 'a@b.co', name: 'A' };
const conflict = (constraint: string) =>
  new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate'), { code: '23505', constraint }));

describe('UsersService', () => {
  it('inserts (never upserts) the user with the caller-supplied id', async () => {
    const repo = { create: jest.fn((v) => ({ ...v })), insert: jest.fn().mockResolvedValue(undefined) };
    await expect(makeService(repo).create(dto)).resolves.toMatchObject(dto);
    expect(repo.insert).toHaveBeenCalledTimes(1);
  });

  it('maps a duplicate email to 409', async () => {
    const repo = { create: jest.fn((v) => v), insert: jest.fn().mockRejectedValue(conflict('users_email_key')) };
    await expect(makeService(repo).create(dto)).rejects.toThrow('email already exists');
  });

  it('maps a duplicate id to a different 409', async () => {
    const repo = { create: jest.fn((v) => v), insert: jest.fn().mockRejectedValue(conflict('users_pkey')) };
    const err = await makeService(repo)
      .create(dto)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toContain('id already exists');
  });

  it('does not swallow unexpected errors', async () => {
    const repo = { create: jest.fn((v) => v), insert: jest.fn().mockRejectedValue(new Error('boom')) };
    await expect(makeService(repo).create(dto)).rejects.toThrow('boom');
  });

  it('throws 404 for an unknown user', async () => {
    const repo = { findOneBy: jest.fn().mockResolvedValue(null) };
    await expect(makeService(repo).findOne('x')).rejects.toBeInstanceOf(NotFoundException);
  });
});
