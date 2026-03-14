import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionsController } from './connections.controller';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WorkersService } from '../workers/workers.service';
import { WahaService } from '../waha/waha.service';
import { StripeService } from '../billing/stripe.service';
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

describe('ConnectionsController', () => {
  let controller: ConnectionsController;
  let db: ReturnType<typeof createMockDb>;
  let workersService: { findOrProvisionWorker: jest.Mock; assignSession: jest.Mock; getWorkerForSession: jest.Mock; unassignSession: jest.Mock };
  let wahaService: { createSession: jest.Mock; startSession: jest.Mock; stopSession: jest.Mock; getQrCode: jest.Mock; restartSession: jest.Mock; resetSession: jest.Mock; deleteSession: jest.Mock; getSession: jest.Mock; resolveSessionName: jest.Mock; logoutSession: jest.Mock };
  let configService: { get: jest.Mock };
  let stripeService: { getPaidSlots: jest.Mock; createCheckoutSession: jest.Mock; getSubscriptionStatus: jest.Mock; createPortalSession: jest.Mock; constructWebhookEvent: jest.Mock; createCustomer: jest.Mock };

  beforeEach(async () => {
    db = createMockDb();

    workersService = {
      findOrProvisionWorker: jest.fn(),
      assignSession: jest.fn(),
      getWorkerForSession: jest.fn(),
      unassignSession: jest.fn(),
    };

    wahaService = {
      createSession: jest.fn(),
      startSession: jest.fn(),
      stopSession: jest.fn(),
      getQrCode: jest.fn(),
      restartSession: jest.fn(),
      resetSession: jest.fn(),
      deleteSession: jest.fn(),
      getSession: jest.fn().mockRejectedValue(new Error('Not found')),
      resolveSessionName: jest.fn().mockImplementation((name: string) => name),
      logoutSession: jest.fn(),
    };

    configService = {
      get: jest.fn().mockReturnValue('http://localhost:3001'),
    };

    stripeService = {
      getPaidSlots: jest.fn(),
      createCheckoutSession: jest.fn(),
      getSubscriptionStatus: jest.fn(),
      createPortalSession: jest.fn(),
      constructWebhookEvent: jest.fn(),
      createCustomer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConnectionsController],
      providers: [
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: WorkersService, useValue: workersService },
        { provide: WahaService, useValue: wahaService },
        { provide: ConfigService, useValue: configService },
        { provide: StripeService, useValue: stripeService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ConnectionsController>(ConnectionsController);
  });

  const user = { sub: 'user-123' };

  describe('listConnections', () => {
    it('should return sessions belonging to the user', async () => {
      const sessions = [
        { id: 'sess-1', userId: 'user-123', sessionName: 'u_user-123_s_abc', status: 'working' },
        { id: 'sess-2', userId: 'user-123', sessionName: 'u_user-123_s_def', status: 'scan_qr' },
      ];
      db.where.mockResolvedValue(sessions);

      const result = await controller.listConnections(user);

      expect(result).toEqual(sessions);
      expect(db.select).toHaveBeenCalled();
      expect(db.from).toHaveBeenCalled();
      expect(db.where).toHaveBeenCalled();
    });

    it('should return empty array when user has no sessions', async () => {
      db.where.mockResolvedValue([]);

      const result = await controller.listConnections(user);

      expect(result).toEqual([]);
    });
  });

  describe('createConnection', () => {
    it('should insert a session, provision worker, create/start WAHA session, and return updated record when user has available slots', async () => {
      const created = { id: 'sess-new', userId: 'user-123', sessionName: 'u_user123_s_uuid', status: 'pending' };
      const updated = { ...created, status: 'scan_qr' };
      const worker = { id: 'worker-1', internalIp: '10.0.0.1', apiKey: 'key-123' };
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_123' };

      // First where() for user lookup (billing check)
      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getPaidSlots.mockResolvedValue(5);
      // Second where() for active connections count (billing check)
      db.where.mockResolvedValueOnce([{ id: 'sess-existing' }]);
      // returning() from insert
      db.returning.mockResolvedValueOnce([created]);
      // returning() from update
      db.returning.mockResolvedValueOnce([updated]);

      workersService.findOrProvisionWorker.mockResolvedValue(worker);
      workersService.assignSession.mockResolvedValue(undefined);
      wahaService.createSession.mockResolvedValue({});
      wahaService.startSession.mockResolvedValue(undefined);

      const result = await controller.createConnection(user);

      expect(result).toEqual(updated);
      expect(stripeService.getPaidSlots).toHaveBeenCalledWith('cus_123');
      expect(db.insert).toHaveBeenCalled();
      expect(workersService.findOrProvisionWorker).toHaveBeenCalled();
      expect(workersService.assignSession).toHaveBeenCalledWith('worker-1', 'sess-new');
      expect(wahaService.createSession).toHaveBeenCalledWith(
        '10.0.0.1',
        'key-123',
        expect.any(String),
        'http://localhost:3001/api/events/waha',
      );
      expect(wahaService.startSession).toHaveBeenCalledWith(
        '10.0.0.1',
        'key-123',
        expect.any(String),
      );
    });

    it('should allow admin users to create connections without billing', async () => {
      const created = { id: 'sess-new', userId: 'user-123', sessionName: 'u_user123_s_uuid', status: 'pending' };
      const dbUser = { id: 'user-123', email: 'admin@example.com', stripeCustomerId: null, isAdmin: true };

      // First where() for user lookup (billing check) - admin with no stripe
      db.where.mockResolvedValueOnce([dbUser]);
      // returning() from insert
      db.returning.mockResolvedValueOnce([created]);

      workersService.findOrProvisionWorker.mockRejectedValue(new Error('No workers'));

      const result = await controller.createConnection(user);

      expect(result).toEqual(created);
      expect(stripeService.getPaidSlots).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException when all slots are in use', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_123' };

      // User lookup
      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getPaidSlots.mockResolvedValue(2);
      // Active connections = 2 (all slots used)
      db.where.mockResolvedValueOnce([{ id: 'sess-1' }, { id: 'sess-2' }]);

      await expect(controller.createConnection(user)).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when non-admin user has no Stripe customer', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: null, isAdmin: false };

      db.where.mockResolvedValueOnce([dbUser]);

      await expect(controller.createConnection(user)).rejects.toThrow(ForbiddenException);
    });

    it('should return the created record if provisioning fails', async () => {
      const created = { id: 'sess-new', userId: 'user-123', sessionName: 'u_user123_s_uuid', status: 'pending' };
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_123' };

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getPaidSlots.mockResolvedValue(5);
      db.where.mockResolvedValueOnce([]);
      db.returning.mockResolvedValueOnce([created]);
      workersService.findOrProvisionWorker.mockRejectedValue(new Error('No workers'));

      const result = await controller.createConnection(user);

      expect(result).toEqual(created);
    });
  });

  describe('getConnection', () => {
    it('should return the connection when found and owned by user', async () => {
      const connection = { id: 'sess-1', userId: 'user-123', sessionName: 'u_user-123_s_abc', status: 'working' };
      db.where.mockResolvedValue([connection]);

      const result = await controller.getConnection('sess-1', user);

      expect(result).toEqual(connection);
    });

    it('should throw NotFoundException when connection not found', async () => {
      db.where.mockResolvedValue([]);

      await expect(controller.getConnection('nonexistent', user)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when connection belongs to another user', async () => {
      const connection = { id: 'sess-1', userId: 'other-user', sessionName: 'u_other_s_abc', status: 'working' };
      db.where.mockResolvedValue([connection]);

      await expect(controller.getConnection('sess-1', user)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getQrCode', () => {
    it('should call wahaService.getQrCode with correct worker info', async () => {
      const connection = { id: 'sess-1', userId: 'user-123', sessionName: 'u_user-123_s_abc', status: 'scan_qr' };
      const worker = { id: 'worker-1', internalIp: '10.0.0.1', apiKeyEnc: 'key-enc-123' };
      const qrData = { value: 'qr-code-data' };

      db.where.mockResolvedValue([connection]);
      workersService.getWorkerForSession.mockResolvedValue(worker);
      wahaService.getQrCode.mockResolvedValue(qrData);

      const result = await controller.getQrCode('sess-1', user);

      expect(result).toEqual(qrData);
      expect(wahaService.getQrCode).toHaveBeenCalledWith('10.0.0.1', 'key-enc-123', 'u_user-123_s_abc');
    });

    it('should throw NotFoundException when connection not found', async () => {
      db.where.mockResolvedValue([]);

      await expect(controller.getQrCode('nonexistent', user)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when connection belongs to another user', async () => {
      const connection = { id: 'sess-1', userId: 'other-user', sessionName: 'u_other_s_abc', status: 'scan_qr' };
      db.where.mockResolvedValue([connection]);

      await expect(controller.getQrCode('sess-1', user)).rejects.toThrow(ForbiddenException);
    });

    it('should throw ServiceUnavailableException when no worker is assigned', async () => {
      const connection = { id: 'sess-1', userId: 'user-123', sessionName: 'u_user-123_s_abc', status: 'scan_qr' };
      db.where.mockResolvedValue([connection]);
      workersService.getWorkerForSession.mockResolvedValue(null);

      await expect(controller.getQrCode('sess-1', user)).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('deleteConnection', () => {
    it('should stop WAHA session, unassign worker, and update status to stopped', async () => {
      const connection = { id: 'sess-1', userId: 'user-123', sessionName: 'u_user-123_s_abc', status: 'working' };
      const worker = { id: 'worker-1', internalIp: '10.0.0.1', apiKeyEnc: 'key-enc-123' };
      const updated = { ...connection, status: 'stopped' };

      // First where() is from the select lookup
      db.where.mockResolvedValueOnce([connection]);
      // The update chain ends with returning()
      db.returning.mockResolvedValueOnce([updated]);

      workersService.getWorkerForSession.mockResolvedValue(worker);
      wahaService.stopSession.mockResolvedValue(undefined);
      workersService.unassignSession.mockResolvedValue(undefined);

      const result = await controller.deleteConnection('sess-1', user);

      expect(result).toEqual(updated);
      expect(wahaService.stopSession).toHaveBeenCalledWith('10.0.0.1', 'key-enc-123', 'u_user-123_s_abc');
      expect(workersService.unassignSession).toHaveBeenCalledWith('worker-1', 'sess-1');
    });

    it('should throw NotFoundException when connection not found', async () => {
      db.where.mockResolvedValue([]);

      await expect(controller.deleteConnection('nonexistent', user)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when connection belongs to another user', async () => {
      const connection = { id: 'sess-1', userId: 'other-user', sessionName: 'u_other_s_abc', status: 'working' };
      db.where.mockResolvedValue([connection]);

      await expect(controller.deleteConnection('sess-1', user)).rejects.toThrow(ForbiddenException);
    });

    it('should still update status even if stopping WAHA session fails', async () => {
      const connection = { id: 'sess-1', userId: 'user-123', sessionName: 'u_user-123_s_abc', status: 'working' };
      const updated = { ...connection, status: 'stopped' };

      db.where.mockResolvedValueOnce([connection]);
      db.returning.mockResolvedValueOnce([updated]);

      workersService.getWorkerForSession.mockRejectedValue(new Error('Worker unreachable'));

      const result = await controller.deleteConnection('sess-1', user);

      expect(result).toEqual(updated);
    });
  });
});
