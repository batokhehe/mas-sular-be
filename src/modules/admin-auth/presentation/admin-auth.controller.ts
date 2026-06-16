import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminAuthService } from '../admin-auth.service';
import { AdminLoginDto } from '../application/dto/admin-auth.dto';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { CurrentAdmin, AdminUser } from '../../../common/decorators/current-admin.decorator';

@ApiTags('admin-auth')
@Controller({ path: 'admin/auth', version: '1' })
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  login(@Body() dto: AdminLoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @UseGuards(AdminGuard)
  @Get('me')
  me(@CurrentAdmin() admin: AdminUser) {
    return {
      id: admin.sub,
      email: admin.email,
      name: admin.name,
      isActive: admin.isActive,
      permissions: admin.permissions,
    };
  }

  @UseGuards(AdminGuard)
  @Post('logout')
  logout() {
    return { success: true };
  }
}
