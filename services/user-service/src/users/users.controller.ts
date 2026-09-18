import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { assertSelfOrAdmin, CurrentPrincipal, Roles } from '../auth/auth.decorators';
import { Principal } from '../auth/token-verifier';
import { CreateUserDto } from './create-user.dto';
import { UsersService } from './users.service';

@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @HttpCode(201)
  @Roles('admin')
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get(':id')
  @Roles('customer', 'admin')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal) {
    assertSelfOrAdmin(principal, id);
    return this.users.findOne(id);
  }
}
