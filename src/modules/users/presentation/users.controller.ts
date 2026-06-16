import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../database/prisma.service';
import { CurrentUser, AuthUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CreateAddressDto, UpdateAddressDto } from '../application/dto/address.dto';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.prisma.user.findUnique({
      where: { id: user.sub },
      include: {
        roles: { include: { role: true } },
        addresses: { where: { deletedAt: null }, orderBy: { isDefault: 'desc' } },
      },
    });
  }

  @Get('me/addresses')
  getAddresses(@CurrentUser() user: AuthUser) {
    return this.prisma.address.findMany({
      where: { userId: user.sub, deletedAt: null },
      orderBy: { isDefault: 'desc' },
    });
  }

  @Post('me/addresses')
  async createAddress(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    return this.prisma.$transaction(async (prisma) => {
      if (dto.isDefault) {
        await prisma.address.updateMany({
          where: { userId: user.sub, isDefault: true },
          data: { isDefault: false },
        });
      }

      const address = await prisma.address.create({
        data: {
          ...dto,
          userId: user.sub,
        },
      });

      await prisma.user.update({
        where: { id: user.sub },
        data: { isOnboarded: true },
      });

      return address;
    });
  }

  @Patch('me/addresses/:id')
  async updateAddress(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    // Ownership check (generic 404 — never reveals other users' addresses).
    const owned = await this.prisma.address.findFirst({
      where: { id, userId: user.sub, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Address not found');

    return this.prisma.$transaction(async (prisma) => {
      if (dto.isDefault) {
        await prisma.address.updateMany({
          where: { userId: user.sub, isDefault: true },
          data: { isDefault: false },
        });
      }
      return prisma.address.update({ where: { id }, data: { ...dto } });
    });
  }

  @Delete('me/addresses/:id')
  async deleteAddress(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    // Ownership-scoped soft delete.
    const result = await this.prisma.address.updateMany({
      where: { id, userId: user.sub, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Address not found');
    return { success: true };
  }
}
