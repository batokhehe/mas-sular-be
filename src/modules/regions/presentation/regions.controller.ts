import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ListCitiesQueryDto,
  ListDistrictsQueryDto,
  ListProvincesQueryDto,
  ListVillagesQueryDto,
} from '../application/dto/region-query.dto';
import { RegionsService } from '../regions.service';

/**
 * Public master-address lookups for chain-select forms.
 *   GET /api/v1/regions/provinces
 *   GET /api/v1/regions/cities?provinceId=
 *   GET /api/v1/regions/districts?cityId=
 *   GET /api/v1/regions/villages?districtId=
 * All support `search`, `limit`, and `isActive`.
 */
@ApiTags('regions')
@Controller({ path: 'regions', version: '1' })
export class RegionsController {
  constructor(private readonly regions: RegionsService) {}

  @Get('provinces')
  listProvinces(@Query() query: ListProvincesQueryDto) {
    return this.regions.listProvinces(query);
  }

  @Get('cities')
  listCities(@Query() query: ListCitiesQueryDto) {
    return this.regions.listCities(query);
  }

  @Get('districts')
  listDistricts(@Query() query: ListDistrictsQueryDto) {
    return this.regions.listDistricts(query);
  }

  @Get('villages')
  listVillages(@Query() query: ListVillagesQueryDto) {
    return this.regions.listVillages(query);
  }
}
