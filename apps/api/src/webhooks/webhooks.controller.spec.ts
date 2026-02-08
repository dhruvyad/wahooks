import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { AuthGuard } from '../auth/auth.guard';

function createMockDb() {
  const mock: any = {};
  mock.select = jest.fn().mockReturnValue(mock);
  mock.from = jest.fn().mockReturnValue(mock);
  mock.where = jest.fn().mockReturnValue(mock);
  mock.insert = jest.fn().mockReturnValue(mock);
  mock.values = jest.fn().mockReturnValue(mock);
  mock.returning = jest.fn().mockResolvedValue([]);
  mock.update = jest.fn().mockReturnValue(mock);
  mock.set = jest.fn().mockReturnValue(mock);
  mock.delete = jest.fn().mockReturnValue(mock);
  mock.orderBy = jest.fn().mockReturnValue(mock);
  mock.limit = jest.fn().mockResolvedValue([]);
  mock.and = jest.fn().mockReturnValue(mock);
  return mock;
}

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let db: ReturnType<typeof createMockDb>;

  const user = { sub: 'user-123' };
  const connectionId = 'conn-1';

  beforeEach(async () => {
    db = createMockDb();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: DRIZZLE_TOKEN, useValue: db },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  describe('listWebhooks', () => {
    it('should return webhook configs for a connection after ownership check', async () => {
      const connection = { id: connectionId, userId: 'user-123' };
      const webhookConfigs = [
        { id: 'wh-1', sessionId: connectionId, url: 'https://example.com/hook', events: ['message'] },
        { id: 'wh-2', sessionId: connectionId, url: 'https://example.com/hook2', events: ['*'] },
      ];

      // First where() call is for verifyConnectionOwnership
      db.where.mockResolvedValueOnce([connection]);
      // Second where() call is for listing webhooks
      db.where.mockResolvedValueOnce(webhookConfigs);

      const result = await controller.listWebhooks(connectionId, user);

      expect(result).toEqual(webhookConfigs);
    });

    it('should throw NotFoundException when connection not found', async () => {
      db.where.mockResolvedValueOnce([]);

      await expect(controller.listWebhooks('nonexistent', user)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when connection belongs to another user', async () => {
      const connection = { id: connectionId, userId: 'other-user' };
      db.where.mockResolvedValueOnce([connection]);

      await expect(controller.listWebhooks(connectionId, user)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('createWebhook', () => {
    it('should create a webhook config with auto-generated signing secret', async () => {
      const connection = { id: connectionId, userId: 'user-123' };
      const dto = { url: 'https://example.com/hook', events: ['message', 'status'] };
      const createdWebhook = {
        id: 'wh-new',
        userId: 'user-123',
        sessionId: connectionId,
        url: dto.url,
        events: dto.events,
        signingSecret: 'generated-secret',
      };

      // verifyConnectionOwnership
      db.where.mockResolvedValueOnce([connection]);
      // insert().values().returning()
      db.returning.mockResolvedValueOnce([createdWebhook]);

      const result = await controller.createWebhook(connectionId, dto, user);

      expect(result).toEqual(createdWebhook);
      expect(db.insert).toHaveBeenCalled();
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          sessionId: connectionId,
          url: dto.url,
          events: dto.events,
          signingSecret: expect.any(String),
        }),
      );
    });

    it('should throw NotFoundException when connection does not exist', async () => {
      db.where.mockResolvedValueOnce([]);

      await expect(
        controller.createWebhook('nonexistent', { url: 'https://example.com', events: ['*'] }, user),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateWebhook', () => {
    it('should update webhook config fields', async () => {
      const config = { id: 'wh-1', userId: 'user-123', url: 'https://old.com', events: ['message'] };
      const updatedConfig = { ...config, url: 'https://new.com', events: ['message', 'status'] };
      const dto = { url: 'https://new.com', events: ['message', 'status'] };

      // findWebhookConfigOrFail
      db.where.mockResolvedValueOnce([config]);
      // update().set().where().returning()
      db.returning.mockResolvedValueOnce([updatedConfig]);

      const result = await controller.updateWebhook('wh-1', dto, user);

      expect(result).toEqual(updatedConfig);
      expect(db.update).toHaveBeenCalled();
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://new.com',
          events: ['message', 'status'],
        }),
      );
    });

    it('should throw ForbiddenException when webhook belongs to another user', async () => {
      const config = { id: 'wh-1', userId: 'other-user', url: 'https://example.com', events: ['*'] };
      db.where.mockResolvedValueOnce([config]);

      await expect(
        controller.updateWebhook('wh-1', { url: 'https://new.com' }, user),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when webhook config not found', async () => {
      db.where.mockResolvedValueOnce([]);

      await expect(
        controller.updateWebhook('nonexistent', { url: 'https://new.com' }, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should only update fields present in the DTO', async () => {
      const config = { id: 'wh-1', userId: 'user-123', url: 'https://example.com', events: ['message'], active: true };
      const updatedConfig = { ...config, active: false };
      const dto = { active: false };

      db.where.mockResolvedValueOnce([config]);
      db.returning.mockResolvedValueOnce([updatedConfig]);

      await controller.updateWebhook('wh-1', dto, user);

      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({
          active: false,
          updatedAt: expect.any(Date),
        }),
      );
      // url and events should NOT be in the set call
      const setArg = db.set.mock.calls[0][0];
      expect(setArg).not.toHaveProperty('url');
      expect(setArg).not.toHaveProperty('events');
    });
  });

  describe('deleteWebhook', () => {
    it('should delete the webhook config and return success', async () => {
      const config = { id: 'wh-1', userId: 'user-123', url: 'https://example.com', events: ['*'] };
      db.where.mockResolvedValueOnce([config]);

      const result = await controller.deleteWebhook('wh-1', user);

      expect(result).toEqual({ success: true });
      expect(db.delete).toHaveBeenCalled();
    });

    it('should throw ForbiddenException when webhook belongs to another user', async () => {
      const config = { id: 'wh-1', userId: 'other-user', url: 'https://example.com', events: ['*'] };
      db.where.mockResolvedValueOnce([config]);

      await expect(controller.deleteWebhook('wh-1', user)).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when webhook config not found', async () => {
      db.where.mockResolvedValueOnce([]);

      await expect(controller.deleteWebhook('nonexistent', user)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getWebhookLogs', () => {
    it('should return event logs for the webhook config', async () => {
      const config = { id: 'wh-1', userId: 'user-123' };
      const logs = [
        { id: 'log-1', webhookConfigId: 'wh-1', eventType: 'message', status: 'delivered' },
        { id: 'log-2', webhookConfigId: 'wh-1', eventType: 'status', status: 'pending' },
      ];

      // findWebhookConfigOrFail
      db.where.mockResolvedValueOnce([config]);
      // limit() resolves the logs query chain
      db.limit.mockResolvedValueOnce(logs);

      const result = await controller.getWebhookLogs('wh-1', user);

      expect(result).toEqual(logs);
      expect(db.orderBy).toHaveBeenCalled();
      expect(db.limit).toHaveBeenCalledWith(100);
    });

    it('should throw ForbiddenException when webhook belongs to another user', async () => {
      const config = { id: 'wh-1', userId: 'other-user' };
      db.where.mockResolvedValueOnce([config]);

      await expect(controller.getWebhookLogs('wh-1', user)).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when webhook config not found', async () => {
      db.where.mockResolvedValueOnce([]);

      await expect(controller.getWebhookLogs('nonexistent', user)).rejects.toThrow(NotFoundException);
    });
  });
});
