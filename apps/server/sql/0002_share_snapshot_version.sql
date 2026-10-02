-- 画册分享链接绑定发布快照版本：历史版本对外冻结，之后的改动只能产生新版本。
-- NULL 仅用于单卡（scope='inspiration'）分享；画册分享必须指向一个已发布版本。
ALTER TABLE share_link ADD COLUMN snapshot_version INTEGER;

-- 存量画册分享：回填为该画册当前最新版本（无快照则保持 NULL，公开页会按"未发布"处理）。
UPDATE share_link
SET snapshot_version = (
  SELECT MAX(album_snapshot.version)
  FROM album_snapshot
  WHERE album_snapshot.album_id = share_link.scope_id
)
WHERE scope = 'album';
