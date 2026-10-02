import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { createShareLinkSchema, type FuzzLevel } from '@flil/shared';
import { getDb, nowIso } from '../db.js';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import {
  createShareLink,
  listAccessLogs,
  listShareLinks,
  logAccess,
  revokeShareLink,
  shareStatus,
  validateShareToken,
} from '../services/share.js';
import { publicItemsFromSnapshot, snapshotContainsAsset, snapshotForShareLink } from '../services/albums.js';
import { requireInspiration } from '../services/inspirations.js';
import { toInspirationDto } from '../services/serialization.js';
import { shareImageFor, type AssetRow } from '../services/assets.js';

export const shareRouter = Router();
export const publicShareRouter = Router();

shareRouter.use(authenticate());

shareRouter.post(
  '/share-links',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createShareLinkSchema.parse(req.body);
    const link = createShareLink({
      libraryId: ctx.libraryId,
      scope: input.scope,
      scopeId: input.scopeId,
      fuzzLevel: input.fuzzLevel as FuzzLevel,
      expiresInDays: input.expiresInDays,
      password: input.password ?? null,
      userId: req.auth!.id,
    });
    const snapshotVersion = link.snapshot_id
      ? ((getDb().prepare('SELECT version FROM album_snapshot WHERE id = ?').get(link.snapshot_id) as
          | { version: number }
          | undefined)?.version ?? null)
      : null;
    // 明确告知是否发生了强制降级，避免用户误以为用了精确坐标
    ok(
      res,
      {
        id: link.id,
        token: link.token,
        url: `/share/${link.token}`,
        fuzzLevel: link.fuzz_level,
        downgraded: link.fuzz_level !== input.fuzzLevel,
        expiresAt: link.expires_at,
        snapshotVersion,
      },
      201,
    );
  }),
);

shareRouter.get(
  '/share-links',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, {
      items: listShareLinks(ctx.libraryId).map((l) => ({
        id: l.id,
        scope: l.scope,
        scopeId: l.scope_id,
        token: l.token,
        fuzzLevel: l.fuzz_level,
        hasPassword: Boolean(l.password_hash),
        expiresAt: l.expires_at,
        status: shareStatus(l),
        viewCount: l.view_count,
        createdAt: l.created_at,
        snapshotVersion: l.snapshot_version ?? null,
      })),
    });
  }),
);

shareRouter.post(
  '/share-links/:id/revoke',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    revokeShareLink(req.params.id, ctx.libraryId);
    ok(res, { revoked: true });
  }),
);

shareRouter.get(
  '/share-links/:id/logs',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, { items: listAccessLogs(req.params.id, ctx.libraryId) });
  }),
);

/** 隐私巡检：列出全部有效分享，供"一键巡检/批量撤销"使用（文档 13.6） */
shareRouter.get(
  '/share-links/audit',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const links = listShareLinks(ctx.libraryId);
    ok(res, {
      active: links.filter((l) => shareStatus(l) === 'active').length,
      expired: links.filter((l) => shareStatus(l) === 'expired').length,
      revoked: links.filter((l) => shareStatus(l) === 'revoked').length,
      items: links.map((l) => ({
        id: l.id,
        scope: l.scope,
        fuzzLevel: l.fuzz_level,
        expiresAt: l.expires_at,
        status: shareStatus(l),
        viewCount: l.view_count,
      })),
    });
  }),
);

// ------------------------------------------------------------ 公开分享访问

function passwordFrom(req: { query: unknown; header: (n: string) => string | undefined }): string | null {
  const q = req.query as Record<string, string | undefined>;
  return q.password ?? req.header('x-share-password') ?? null;
}

/**
 * 只读分享视图（无需登录）。
 * 画册内容只来自链接钉住的冻结快照——发布后增删条目不会改变既有分享内容，
 * 后续改动只有重新发布、生成新版本和新链接才会对外可见。
 * 输出中**只有模糊坐标**（且不超过链接允许的级别），每次请求都会重新校验撤销与过期。
 */
publicShareRouter.get(
  '/share/:token',
  ah(async (req, res) => {
    const link = validateShareToken(req.params.token, passwordFrom(req));

    if (link.scope === 'album') {
      const snapshot = snapshotForShareLink({
        id: link.id,
        scopeId: link.scope_id,
        snapshotId: link.snapshot_id,
      });
      if (!snapshot) {
        logAccess(link.id, false, 'album_snapshot_missing');
        throw errors.notFound('分享内容（画册尚未发布）');
      }
      const linkLevel = link.fuzz_level as FuzzLevel;
      const items = publicItemsFromSnapshot(snapshot.payload, linkLevel);
      const payload = snapshot.payload as Record<string, unknown>;
      logAccess(link.id, true);
      return ok(res, {
        scope: 'album',
        fuzzLevel: link.fuzz_level,
        expiresAt: link.expires_at,
        version: snapshot.version,
        // 快照元信息只投影公开字段：完整 payload（含条目与快照级模糊坐标）不直接外发
        snapshot: {
          version: snapshot.version,
          payloadHash: snapshot.payloadHash,
          createdAt: snapshot.createdAt,
          payload: {
            title: payload.title ?? null,
            themeNote: payload.themeNote ?? null,
            conditionSummary: payload.conditionSummary ?? null,
            publishedAt: payload.publishedAt ?? null,
            fuzzLevel: payload.fuzzLevel ?? null,
            itemCount: items.length,
          },
        },
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          caption: i.caption,
          tags: i.tags,
          fuzz: i.fuzz,
          anchor: i.anchor,
          assets: i.assets.map((a) => ({ id: a.id, width: a.width, height: a.height, url: `/api/share/${link.token}/assets/${a.id}` })),
        })),
        notice: `内容为发布时冻结的第 ${snapshot.version} 版，不随后续编辑变化；链接可能过期或被撤销。地点已按分享级别模糊化。`,
      });
    }

    const ctx = {
      libraryId: link.library_id,
      role: 'member' as const,
      defaultFuzzLevel: link.fuzz_level as FuzzLevel,
      includePrecise: false,
    };
    const row = requireInspiration(link.scope_id, link.library_id);
    const dto = toInspirationDto(row, ctx);
    logAccess(link.id, true);
    ok(res, {
      scope: 'inspiration',
      fuzzLevel: link.fuzz_level,
      expiresAt: link.expires_at,
      item: {
        id: dto.id,
        title: dto.title,
        note: dto.note,
        tags: dto.tags,
        fuzz: dto.spot?.fuzz ?? null,
        anchor: dto.timing?.timeAnchor ?? null,
        assets: dto.assets.map((a) => ({ id: a.id, width: a.width, height: a.height, url: `/api/share/${link.token}/assets/${a.id}` })),
      },
      notice: '内容随时可能失效；地点已按分享级别模糊化。',
    });
  }),
);

/** 分享图：二次脱敏（剥离 EXIF）后输出，且每次校验撤销/过期 */
publicShareRouter.get(
  '/share/:token/assets/:assetId',
  ah(async (req, res) => {
    const link = validateShareToken(req.params.token, passwordFrom(req));
    const db = getDb();
    const asset = db.prepare('SELECT * FROM asset WHERE id = ?').get(req.params.assetId) as AssetRow | undefined;
    if (!asset) throw errors.notFound('图片');

    // 越权检查：该图片必须属于本次分享范围
    let allowed = false;
    if (link.scope === 'inspiration') {
      allowed = asset.inspiration_id === link.scope_id;
    } else {
      // 画册：只认链接钉住的冻结快照——发布后新加进来的条目图片不可见，
      // 已冻结条目的图片即使后来被移出画册也仍然可见（既有分享内容不变）
      const snapshot = snapshotForShareLink({
        id: link.id,
        scopeId: link.scope_id,
        snapshotId: link.snapshot_id,
      });
      allowed = snapshot ? snapshotContainsAsset(snapshot.payload, asset.id) : false;
    }
    if (!allowed) {
      logAccess(link.id, false, 'asset_out_of_scope');
      throw errors.scopeDenied();
    }

    const target = await shareImageFor(asset, link.library_id);
    if (!fs.existsSync(target)) throw errors.notFound('图片文件');
    logAccess(link.id, true);
    res.sendFile(target);
  }),
);

publicShareRouter.post(
  '/share/:token/verify',
  ah(async (req, res) => {
    const { password } = z.object({ password: z.string().nullable().optional() }).parse(req.body ?? {});
    const link = validateShareToken(req.params.token, password ?? null);
    ok(res, { ok: true, scope: link.scope, fuzzLevel: link.fuzz_level, expiresAt: link.expires_at });
  }),
);

export { nowIso };
