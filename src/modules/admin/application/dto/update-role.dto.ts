import { IsArray, IsDateString, IsOptional, IsString } from 'class-validator';

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissionIds?: string[];

  /**
   * The `updatedAt` the caller read before editing (C7b).
   *
   * Required, and deliberately so: the update replaces the role's permission set
   * wholesale, so without it two administrators editing the same role both succeed
   * and the second silently discards the first's change - reproduced against a real
   * database, not hypothesised. The server compares this against the stored value in
   * the write itself and answers 409 when they differ.
   *
   * It must be the value from the GET that seeded the form. Re-reading it immediately
   * before the PATCH would make the check always pass and restore the defect.
   */
  @IsDateString()
  expectedUpdatedAt!: string;
}
