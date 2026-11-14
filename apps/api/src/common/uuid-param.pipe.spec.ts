import { NotFoundException } from '@nestjs/common';
import { UuidParamPipe } from './uuid-param.pipe';

describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe();
  const param = (data: string) => ({ type: 'param' as const, data });

  it('passes uuids through, in any form Postgres accepts', () => {
    for (const id of [
      'd0bb897c-63ce-4694-8a72-c3dafcf0db89',
      'D0BB897C-63CE-4694-8A72-C3DAFCF0DB89',
      'd0bb897c63ce46948a72c3dafcf0db89',
      '{d0bb897c-63ce-4694-8a72-c3dafcf0db89}',
    ]) {
      expect(pipe.transform(id, param('id'))).toBe(id);
    }
  });

  it('404s an id that cannot be a uuid, instead of a database error', () => {
    expect(() => pipe.transform('noclick-test-1a16e0571b0547b78608b938abde9a73', param('connectionId'))).toThrow(
      new NotFoundException('Connection not found'),
    );
    expect(() => pipe.transform('15551234567', param('id'))).toThrow(NotFoundException);
    expect(() => pipe.transform('d0bb897c-63ce-4694-8a72', param('id'))).toThrow(NotFoundException);
  });

  it('leaves other parameters and bodies alone', () => {
    expect(pipe.transform('123@lid', param('chatId'))).toBe('123@lid');
    expect(pipe.transform({ id: 'x' }, { type: 'body' })).toEqual({ id: 'x' });
  });
});
