import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../database/prisma.service';
import { SaveCartDto } from '../application/dto/cart.dto';
import { randomUUID } from 'crypto';

@ApiTags('cart')
@Controller({ path: 'cart', version: '1' })
export class CartController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('sessions')
  createSession(@Body() dto: SaveCartDto) {
    return this.prisma.cartSession.create({
      data: {
        token: randomUUID(),
        payload: dto as never,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });
  }
}
