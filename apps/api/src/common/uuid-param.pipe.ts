import { ArgumentMetadata, Injectable, NotFoundException, PipeTransform } from '@nestjs/common';

/** What Postgres accepts as a uuid: 32 hex digits, a hyphen optional after any group of four, optional braces. */
const POSTGRES_UUID = /^\{?[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}?$/i;

/**
 * Every `:id` and `:connectionId` route parameter names a row by its uuid. Anything else can't name one, so it's a
 * 404 here instead of Postgres rejecting the query ("invalid input syntax for type uuid") as a 500.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'param' || (metadata.data !== 'id' && metadata.data !== 'connectionId')) return value;
    if (typeof value === 'string' && POSTGRES_UUID.test(value)) return value;
    throw new NotFoundException(metadata.data === 'connectionId' ? 'Connection not found' : 'Not found');
  }
}
