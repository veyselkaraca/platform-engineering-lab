import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { CreateUserDto } from './create-user.dto';
import { User } from './user.entity';

const PG_UNIQUE_VIOLATION = '23505';
const PK_CONSTRAINT = 'users_pkey';

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  async create(dto: CreateUserDto): Promise<User> {
    const user = this.repo.create(dto);
    try {
      // insert, not save: with a caller-supplied id, save would UPDATE an existing row instead of conflicting.
      await this.repo.insert(user);
      return user;
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const driver = err.driverError as { code?: string; constraint?: string };
        if (driver?.code === PG_UNIQUE_VIOLATION) {
          throw new ConflictException(
            driver.constraint === PK_CONSTRAINT ? 'A user with this id already exists' : 'A user with this email already exists',
          );
        }
      }
      throw err;
    }
  }

  async findOne(id: string): Promise<User> {
    const user = await this.repo.findOneBy({ id });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
