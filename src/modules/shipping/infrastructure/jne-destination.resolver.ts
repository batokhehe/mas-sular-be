import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

/**
 * PAXELBOX-61S: internal District -> JNE destination code, at runtime.
 *
 * ---------------------------------------------------------------------------
 * WHY A RESOLVER AND NOT A COLUMN
 *
 * JNE addresses destinations by its OWN code, and its granularity is its own:
 * predominantly district-level, matching no Kemendagri level exactly. The
 * mapping from our District to that code is reviewed data, approved one district
 * at a time with the evidence recorded (PAXELBOX-61F..61H) - not something a
 * formula can derive. So the code is looked up, never computed.
 *
 * ---------------------------------------------------------------------------
 * EVERY CONDITION IS IN THE WHERE CLAUSE, ON PURPOSE
 *
 * A mapping only counts when it is active, MATCHED, and points at an active
 * DESTINATION row. Filtering in SQL rather than in TypeScript means there is no
 * branch where a REVIEW_REQUIRED, AMBIGUOUS, NOT_FOUND, retired, or ORIGIN row
 * can be read and then discarded - it simply never comes back.
 *
 * `kind: 'DESTINATION'` is the load-bearing one. 601 of JNE's 614 origin codes
 * also exist as destination codes, 62 of them under a different name, and the
 * two namespaces are separate rows sharing a code (PAXELBOX-61P). Querying by
 * code alone would let an ORIGIN row answer a destination question.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED
 *
 * No mapping means no quote. Never a postal code, never Village.rajaOngkirId,
 * never District.code, never a neighbouring district's code. An unmapped address
 * is an expected configuration state - only 30 districts are approved so far -
 * and the honest answer is that JNE cannot be priced there yet.
 */
@Injectable()
export class JneDestinationResolver {
  private readonly logger = new Logger('JneDestinationResolver');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The approved JNE destination code for `districtId`, or null when the
   * district has no usable mapping. Null is a normal answer, not an error.
   */
  async resolve(districtId: string | undefined): Promise<string | null> {
    if (!districtId) return null;

    const mapping = await this.prisma.jneDistrictMapping.findFirst({
      where: {
        districtId,
        isActive: true,
        status: 'MATCHED',
        jneLocation: { kind: 'DESTINATION', isActive: true },
      },
      select: { jneLocation: { select: { code: true } } },
    });

    if (!mapping) {
      // Debug, not warn: an unmapped district is the expected state outside the
      // approved set, and warning on every checkout there would be noise.
      this.logger.debug({ event: 'jne.destination.unmapped', districtId });
      return null;
    }
    return mapping.jneLocation.code;
  }
}
