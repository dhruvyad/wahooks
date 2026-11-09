import { Test, TestingModule } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WEBHOOK_LOG_KEEP, WebhookLogRetentionService } from './webhook-log-retention.service';

describe('WebhookLogRetentionService', () => {
  let service: WebhookLogRetentionService;
  let db: { execute: jest.Mock };
  const dialect = new PgDialect();
  const render = (call: any[]) => dialect.sqlToQuery(call[0]);

  beforeEach(async () => {
    db = { execute: jest.fn().mockResolvedValue(Object.assign([], { count: 0 })) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookLogRetentionService, { provide: DRIZZLE_TOKEN, useValue: db }],
    }).compile();
    service = module.get(WebhookLogRetentionService);
  });

  it('keeps the newest 100 per webhook and spares recent pending rows', async () => {
    db.execute.mockResolvedValueOnce(Object.assign([], { count: 7 }));

    await expect(service.trim('wh-1')).resolves.toBe(7);

    const q = render(db.execute.mock.calls[0]);
    expect(WEBHOOK_LOG_KEEP).toBe(100);
    expect(q.sql).toMatch(/DELETE FROM webhook_event_logs/);
    expect(q.sql).toMatch(/ORDER BY created_at DESC\s+OFFSET \$2/);
    expect(q.sql).toMatch(/status <> 'pending' OR created_at < now\(\) - interval '1 hour'/);
    expect(q.params).toEqual(['wh-1', 100]);
  });

  it('trims only webhooks touched since the last run, once each', async () => {
    service.touch('wh-1');
    service.touch('wh-2');
    service.touch('wh-1');

    await service.trimTouched();
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.execute.mock.calls.map((c) => render(c).params[0]).sort()).toEqual(['wh-1', 'wh-2']);

    db.execute.mockClear();
    await service.trimTouched();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('daily sweep trims every webhook over the limit', async () => {
    db.execute.mockResolvedValueOnce([{ id: 'wh-a' }, { id: 'wh-b' }]);

    await service.trimAll();

    expect(render(db.execute.mock.calls[0]).sql).toMatch(/HAVING count\(\*\) > \$1/);
    expect(db.execute.mock.calls.slice(1).map((c) => render(c).params[0])).toEqual(['wh-a', 'wh-b']);
  });

  it('a failed trim is logged, not thrown', async () => {
    db.execute.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.trim('wh-1')).resolves.toBe(0);
  });
});
