import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FuzzLevel } from '@flil/shared';
import { getDb, newId, nowIso } from '../db.js';
import { config } from '../config.js';
import { errors } from '../http/errors.js';
import { assertShareFuzzLevel, isShareFuzzLevelAllowed } from './fuzzing.js';

export interface ShareLinkRow {
  id: string;
  library_id: string;
  scope: 'album' | 'inspiration';
  scope_id: string;
  token: string;
  fuzz_level: FuzzLevel;
  password_hash: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_by: string;
  view_count: number;
  created_at: string;
  /** 画册分享钉住的冻结快照（inspiration 分享为 null） */
  snapshot_id: string | null;
}

export function createShareLink(params: {
  libraryId: string;
  scope: 'album' | 'inspiration';
  scopeId: string;
  fuzzLevel: FuzzLevel;
  expiresInDays: number;
  password?: string | null;
  userId: string;
  /** 显式指定要钉住的画册快照 */
  snapshotId?: string | null;
  /** 发布流程专用：快照与链接在同一事务里生成，由发布方随后回填 snapshot_id */
  snapshotPending?: boolean;
}): ShareLinkRow {
  if (!config.enableShare) throw errors.badRequest('分享功能已被服务端关闭（ENABLE_SHARE=false）');

  // 安全底线：exact / g100 一律强制降级为 g500（不抛错，避免"手填就绕过"）
  const level = assertShareFuzzLevel(params.fuzzLevel);
  const days = Math.min(Math.max(1, params.expiresInDays), config.shareMaxExpireDays);
  const token = crypto.randomBytes(24).toString('base64url');

  // 画册分享必须钉住一个冻结快照，否则"既有分享内容"会随后续增删条目而变化
  let snapshotId: string | null = null;
  if (params.scope === 'album') {
    if (params.snapshotId) {
      snapshotId = params.snapshotId;
    } else if (!params.snapshotPending) {
      const latest = getDb()
        .prepare('SELECT id FROM album_snapshot WHERE album_id = ? ORDER BY version DESC LIMIT 1')
        .get(params.scopeId) as { id: string } | undefined;
      if (!latest) throw errors.albumNotPublished();
      snapshotId = latest.id;
    }
  }

  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO share_link (id, library_id, scope, scope_id, token, fuzz_level, password_hash,
         expires_at, created_by, view_count, created_at, snapshot_id)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
    )
    .run(
      id,
      params.libraryId,
      params.scope,
      params.scopeId,
      token,
      level,
      params.password ? bcrypt.hashSync(params.password, 10) : null,
      new Date(Date.now() + days * 86400000).toISOString(),
      params.userId,
      nowIso(),
      snapshotId,
    );

  return getDb().prepare('SELECT * FROM share_link WHERE id = ?').get(id) as ShareLinkRow;
}

/** 校验分享令牌：撤销、过期、密码三者都必须校验（文档 13.4） */
export function validateShareToken(token: string, password?: string | null): ShareLinkRow {
  const row = getDb().prepare('SELECT * FROM share_link WHERE token = ?').get(token) as ShareLinkRow | undefined;
  if (!row) throw errors.notFound('分享链接');

  if (row.revoked_at) {
    logAccess(row.id, false, 'revoked');
    throw errors.shareRevoked();
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    logAccess(row.id, false, 'expired');
    throw errors.shareExpired();
  }
  if (row.password_hash) {
    if (!password) {
      logAccess(row.id, false, 'password_required');
      throw errors.sharePasswordRequired();
    }
    if (!bcrypt.compareSync(password, row.password_hash)) {
      logAccess(row.id, false, 'password_wrong');
      throw errors.sharePasswordRequired();
    }
  }
  return row;
}

export function logAccess(shareLinkId: string, allowed: boolean, denyReason?: string): void {
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO share_access_log (id, share_link_id, ip_hash, user_agent, path, allowed, deny_reason, at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(newId(), shareLinkId, null, null, null, allowed ? 1 : 0, denyReason ?? null, nowIso());
    if (allowed) db.prepare('UPDATE share_link SET view_count = view_count + 1 WHERE id = ?').run(shareLinkId);
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 撤销即时生效：接口层每次都会重新读 revoked_at（不接受缓存兜底） */
export function revokeShareLink(id: string, libraryId: string): void {
  const res = getDb()
    .prepare('UPDATE share_link SET revoked_at = ? WHERE id = ? AND library_id = ? AND revoked_at IS NULL')
    .run(nowIso(), id, libraryId);
  if (res.changes === 0) throw errors.notFound('分享链接（可能已被撤销）');
}

export function listShareLinks(libraryId: string): (ShareLinkRow & { snapshot_version: number | null })[] {
  return getDb()
    .prepare(
      `SELECT l.*, s.version AS snapshot_version
       FROM share_link l
       LEFT JOIN album_snapshot s ON s.id = l.snapshot_id
       WHERE l.library_id = ?
       ORDER BY l.created_at DESC`,
    )
    .all(libraryId) as (ShareLinkRow & { snapshot_version: number | null })[];
}

export function shareStatus(link: ShareLinkRow): 'active' | 'expired' | 'revoked' {
  if (link.revoked_at) return 'revoked';
  if (new Date(link.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

export function listAccessLogs(shareLinkId: string, libraryId: string): Record<string, unknown>[] {
  const link = getDb().prepare('SELECT library_id FROM share_link WHERE id = ?').get(shareLinkId) as
    | { library_id: string }
    | undefined;
  if (!link || link.library_id !== libraryId) throw errors.notFound('分享链接');
  return getDb()
    .prepare('SELECT * FROM share_access_log WHERE share_link_id = ? ORDER BY at DESC LIMIT 200')
    .all(shareLinkId) as Record<string, unknown>[];
}

export { isShareFuzzLevelAllowed };
