import { Module } from '@nestjs/common';
import { OUTBOX_CONFIG, loadOutboxConfig } from './outbox.config';
import { OutboxRelayWorker } from './outbox-relay.worker';
import { RabbitConnectionManager } from './rabbit-connection.manager';

@Module({
  providers: [
    { provide: OUTBOX_CONFIG, useFactory: () => loadOutboxConfig() },
    RabbitConnectionManager,
    OutboxRelayWorker,
  ],
  exports: [RabbitConnectionManager],
})
export class OutboxModule {}
