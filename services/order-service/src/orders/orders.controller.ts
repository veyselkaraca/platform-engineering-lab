import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreateOrderDto } from './create-order.dto';
import { OrdersService } from './orders.service';

// AuthN/AuthZ (customer / owner / admin) arrives with the Keycloak slice; see docs/features/order-notification.
@Controller('v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request & { id?: string | number },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 200)) {
      throw new BadRequestException('Idempotency-Key must be 1-200 characters');
    }
    const { order, created } = await this.orders.create(dto, idempotencyKey, String(req.id));
    res.status(created ? 201 : 200);
    return order;
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findOne(id);
  }
}
