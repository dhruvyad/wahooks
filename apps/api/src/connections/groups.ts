import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import type { GroupMember, GroupParticipantChange, WhatsAppGroup } from '@wahooks/shared-types';
import type { WahaGroupMember, WahaGroupMetadata, WahaGroupParticipantResult } from '../waha/waha.types';
import { WorkerHttpError } from '../waha/waha.service';

// Shaping and validation for the /connections/:id/groups routes. The worker answers WAHA NOWEB's group routes
// (Baileys GroupMetadata, `@s.whatsapp.net`/`@lid` ids); callers get the same chatIds the rest of the API uses.

const GROUP_ID = /^\d+(?:-\d+)?(?:@g\.us)?$/;
const MAX_PARTICIPANTS = 256;

/** `120363…@g.us`, with or without its suffix; anything else is a 400. */
export function normalizeGroupId(raw: string): string {
  const id = (raw ?? '').trim();
  if (!GROUP_ID.test(id)) {
    throw new BadRequestException('groupId must be a WhatsApp group id, like 120363012345678901@g.us');
  }
  return id.endsWith('@g.us') ? id : `${id}@g.us`;
}

/** Phone numbers or chatIds (`@c.us`, `@lid`); the worker validates each one. */
export function parseParticipants(raw: unknown, required: boolean): string[] {
  if (raw === undefined || raw === null) {
    if (required) throw new BadRequestException('participants is required: an array of phone numbers or chat ids');
    return [];
  }
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new BadRequestException('participants must be an array of phone numbers or chat ids');
  }
  if (required && raw.length === 0) throw new BadRequestException('participants must not be empty');
  if (raw.length > MAX_PARTICIPANTS) {
    throw new BadRequestException(`At most ${MAX_PARTICIPANTS} participants per request`);
  }
  return raw.map((p: string) => p.trim());
}

const isPn = (jid?: string | null): jid is string => !!jid && /@(s\.whatsapp\.net|c\.us)$/.test(jid);
const isLid = (jid?: string | null): jid is string => !!jid && jid.endsWith('@lid');
const userOf = (jid: string): string => jid.split('@')[0].split(':')[0];

/** One person as the API names them: the chatId to message, the phone digits and the LID when known. */
function identity(id: string, phoneNumber?: string, lid?: string): { id: string; phone: string | null; lid: string | null } {
  const pnJid = isPn(id) ? id : isPn(phoneNumber) ? phoneNumber : null;
  const phone = pnJid ? userOf(pnJid) : null;
  const lidJid = isLid(id) ? userOf(id) + '@lid' : isLid(lid) ? userOf(lid) + '@lid' : null;
  return { id: phone ? `${phone}@c.us` : (lidJid ?? id), phone, lid: lidJid };
}

function mapMember(p: WahaGroupMember, mePhone: string | null): GroupMember {
  const who = identity(p.id, p.phoneNumber, p.lid);
  return {
    ...who,
    name: p.name || p.notify || null,
    role: p.admin === 'superadmin' ? 'superadmin' : p.admin === 'admin' ? 'admin' : 'member',
    isMe: p.isMe === true || (!!mePhone && who.phone === mePhone),
  };
}

export function changeReason(code: number, action: 'add' | 'remove'): string {
  switch (code) {
    case 403:
      return action === 'add'
        ? "Their privacy settings don't let this account add them. Send them the group's invite link instead."
        : 'WhatsApp refused: this account is not allowed to remove them.';
    case 404:
      return action === 'add' ? 'This number is not on WhatsApp.' : 'They are not in the group.';
    case 408:
      return "They left the group recently, so WhatsApp won't add them back yet. Send them the group's invite link instead.";
    case 409:
      return 'They are already in the group.';
    case 401:
      return 'WhatsApp refused; they may have blocked this account.';
    default:
      return `WhatsApp refused (code ${code}).`;
  }
}

/**
 * The group, plus the people WhatsApp didn't add when it was created (the worker lists them among the participants
 * with an error code).
 */
export function mapGroup(
  raw: WahaGroupMetadata,
  mePhone: string | null,
): { group: WhatsAppGroup; notAdded: GroupParticipantChange[] } {
  const all = Array.isArray(raw?.participants) ? raw.participants : [];
  const me = mePhone ? mePhone.replace(/\D/g, '') || null : null;
  const participants = all.filter((p) => !p.error).map((p) => mapMember(p, me));
  const notAdded = all
    .filter((p) => !!p.error)
    .map((p) => ({
      ...identity(p.id, p.phoneNumber, p.lid),
      status: 'failed' as const,
      code: p.error as number,
      reason: changeReason(p.error as number, 'add'),
    }));
  const owner = raw.ownerPn ?? raw.owner;
  const group: WhatsAppGroup = {
    id: raw.id,
    name: raw.subject ?? '',
    description: raw.desc || null,
    owner: owner ? identity(owner).id : null,
    createdAt: typeof raw.creation === 'number' && raw.creation > 0 ? new Date(raw.creation * 1000).toISOString() : null,
    // A community's announcement group lists only some members; size is the server's count.
    participantCount: Math.max(participants.length, typeof raw.size === 'number' && !notAdded.length ? raw.size : 0),
    participants,
    announcementOnly: raw.announce === true,
    locked: raw.restrict === true,
    isCommunity: raw.isCommunity === true,
  };
  return { group, notAdded };
}

export function mapParticipantChange(r: WahaGroupParticipantResult, action: 'add' | 'remove'): GroupParticipantChange {
  const code = parseInt(String(r.status), 10) || 200;
  const who = identity(r.jid, r.phoneNumber, r.lid);
  if (code === 200) return { ...who, status: action === 'add' ? 'added' : 'removed', code: null, reason: null };
  const status =
    action === 'add' && code === 409 ? 'already_member' : action === 'remove' && code === 404 ? 'not_member' : 'failed';
  return { ...who, status, code, reason: changeReason(code, action) };
}

/** The worker's answer to a group call as the API's error. */
export function groupError(error: unknown): HttpException {
  if (error instanceof WorkerHttpError) {
    const { workerStatus: status, detail } = error;
    if (status === 404 && /^Cannot (GET|POST|PUT|DELETE) /.test(detail)) {
      return new NotImplementedException("This connection's WhatsApp server doesn't support groups yet.");
    }
    if (status === 404) return new NotFoundException(detail || 'Group not found');
    if (status === 403) return new ForbiddenException(detail);
    if (status === 400) return new BadRequestException(detail);
    if (status === 422) return new ConflictException("This connection isn't connected to WhatsApp right now.");
    if (status === 429) return new HttpException(detail, 429);
  } else if (error instanceof HttpException && error.getStatus() === 503) {
    return error;
  }
  return new BadGatewayException("Couldn't reach WhatsApp. Try again.");
}
