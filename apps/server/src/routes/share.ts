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
import {
  getFrozenAlbum,
  latestSnapshotVersion,
  requireAlbum,
  snapshotAssetAllowlist,
} from '../services/albums.js';
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

    // 画册分享只能指向一个已发布版本：链接创建时即冻结在当时的最新版本，
    // 之后画册增删条目不影响本链接，需要再次发布生成新版本。
    let snapshotVersion: number | null = null;
    if (input.scope === 'album') {
      requireAlbum(input.scopeId, ctx.libraryId);
      snapshotVersion = latestSnapshotVersion(input.scopeId);
      if (snapshotVersion === null) {
        throw errors.badRequest('画册尚未发布，无法创建分享链接；请先发布一个版本');
      }
    }

    const link = createShareLink({
      libraryId: ctx.libraryId,
      scope: input.scope,
      scopeId: input.scopeId,
      fuzzLevel: input.fuzzLevel as FuzzLevel,
      expiresInDays: input.expiresInDays,
      password: input.password ?? null,
      userId: req.auth!.id,
      snapshotVersion,
    });
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
        snapshotVersion: link.snapshot_version,
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
        snapshotVersion: l.snapshot_version,
        viewCount: l.view_count,
        createdAt: l.created_at,
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
        snapshotVersion: l.snapshot_version,
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
 * 画册分享一律返回"链接所绑定版本"的**冻结快照**——发布后再增删条目、
 * 修改卡片标题/标签/机位都不会改变本链接内容；改动对外可见只能再次发布生成新版本。
 * 输出中**只有模糊坐标**，并且每次请求都会重新校验撤销与过期（不接受缓存兜底）。
 */
publicShareRouter.get(
  '/share/:token',
  ah(async (req, res) => {
    const link = validateShareToken(req.params.token, passwordFrom(req));
    const ctx = {
      libraryId: link.library_id,
      role: 'member' as const,
      defaultFuzzLevel: link.fuzz_level as FuzzLevel,
      includePrecise: false,
    };

    if (link.scope === 'album') {
      const version = link.snapshot_version;
      if (version === null) throw errors.notFound('画册发布版本');
      const frozen = getFrozenAlbum(link.scope_id, version);
      if (!frozen || frozen.payload.albumId !== link.scope_id) throw errors.notFound('画册发布版本');

      const items = frozen.payload.items.map((item) => ({
        id: item.inspirationId,
        title: item.title,
        caption: item.caption,
        tags: item.tags.map((t) => {
          const [domain, ...rest] = t.split(':');
          return { id: t, domain: domain ?? '', name: rest.join(':') };
        }),
        fuzz: item.fuzz as { label: string; geohash: string; lat?: number | null; lng?: number | null } | null,
        anchor: item.anchor,
        assets: item.assets.map((a) => ({
          id: a.id,
          width: a.width,
          height: a.height,
          url: `/api/share/${link.token}/assets/${a.id}`,
        })),
      }));

      const snapshot = {
        version: frozen.version,
        payloadHash: frozen.payloadHash,
        createdAt: frozen.createdAt,
        payload: frozen.payload,
      };

      logAccess(link.id, true);
      return ok(res, {
        scope: 'album',
        fuzzLevel: frozen.payload.fuzzLevel,
        expiresAt: link.expires_at,
        version: frozen.version,
        frozen: true,
        snapshot,
        items,
        notice: `本链接冻结于第 ${frozen.version} 版（${snapshot.createdAt.slice(0, 10)} 发布），之后的改动不会影响你看到的内容；地点已按分享级别模糊化。`,
      });
    }

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

    // 越权检查：该图片必须属于本次分享范围。
    // 画册分享以"链接绑定版本的快照白名单"为准——发布后新加入的图拿不到旧链接，
    // 已移出画册但其图仍在旧快照里的，旧链接仍可访问（历史版本冻结一致）。
    let allowed = false;
    if (link.scope === 'inspiration') {
      allowed = asset.library_id === link.library_id && asset.inspiration_id === link.scope_id;
    } else {
      const version = link.snapshot_version;
      const frozen = version === null ? null : getFrozenAlbum(link.scope_id, version);
      if (!frozen || frozen.payload.albumId !== link.scope_id) throw errors.notFound('画册发布版本');
      // 纵深防御：白名单命中之外，资源还必须属于同一库
      allowed = asset.library_id === link.library_id && snapshotAssetAllowlist(frozen).has(asset.id);
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
