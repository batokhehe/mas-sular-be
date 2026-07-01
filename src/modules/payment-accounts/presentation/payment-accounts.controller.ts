import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { CreatePaymentAccountDto } from '../application/dto/create-payment-account.dto';
import { UpdatePaymentAccountDto } from '../application/dto/update-payment-account.dto';
import { PaymentAccountService } from '../payment-account.service';

@ApiTags('admin-payment-accounts')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/payment-accounts', version: '1' })
export class PaymentAccountsController {
  constructor(private readonly service: PaymentAccountService) {}

  @Permissions('PaymentAccount.read')
  @Get()
  list() {
    return this.service.list();
  }

  @Permissions('PaymentAccount.read')
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Permissions('PaymentAccount.create')
  @Post()
  create(@Body() dto: CreatePaymentAccountDto) {
    return this.service.create(dto);
  }

  @Permissions('PaymentAccount.update')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePaymentAccountDto) {
    return this.service.update(id, dto);
  }

  @Permissions('PaymentAccount.activate')
  @Patch(':id/activate')
  activate(@Param('id') id: string) {
    return this.service.activate(id);
  }

  @Permissions('PaymentAccount.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
