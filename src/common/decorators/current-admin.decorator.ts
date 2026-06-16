import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AdminUser {
  sub: string;
  email: string;
  name: string;
  isActive: boolean;
  role?: string | null;
  permissions: string[];
}

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AdminUser }>();
    return request.user;
  },
);
