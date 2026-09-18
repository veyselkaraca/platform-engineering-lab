import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { assertSelfOrAdmin, CurrentPrincipal, ownerOrNotFound, Roles } from '../auth/auth.decorators';
import { Principal } from '../auth/token-verifier';
import { CreateOrderDto } from './create-order.dto';
import { OrdersService } from './orders.service';

@Controller('v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // A customer orders for themself (token sub == userId); an admin may order for any existing user.
  @Post()
  @Roles('customer', 'admin')
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request & { id?: string | number },
    @Res({ passthrough: true }) res: Response,
  ) {
    assertSelfOrAdmin(principal, dto.userId);
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 200)) {
      throw new BadRequestException('Idempotency-Key must be 1-200 characters');
    }
    const { order, created } = await this.orders.create(dto, idempotencyKey, String(req.id), authorization);
    res.status(created ? 201 : 200);
    return order;
  }

  @Get(':id')
  @Roles('customer', 'admin')
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal) {
    const order = await this.orders.findOne(id);
    ownerOrNotFound(principal, order.userId, 'Order not found');
    return order;
  }
}
