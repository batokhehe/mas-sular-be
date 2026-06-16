import { Module } from '@nestjs/common';
import { CartController } from './presentation/cart.controller';

@Module({ controllers: [CartController] })
export class CartModule {}
