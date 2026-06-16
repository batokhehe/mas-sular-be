import { Module } from '@nestjs/common';
import { UsersController } from './presentation/users.controller';

@Module({ controllers: [UsersController] })
export class UsersModule {}
