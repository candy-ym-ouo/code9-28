-- 分享链接钉住画册快照：发布后增删条目不再改变既有分享内容，后续改动只能生成新版本
PRAGMA foreign_keys = ON;

ALTER TABLE share_link ADD COLUMN snapshot_id TEXT REFERENCES album_snapshot(id) ON DELETE SET NULL;

-- 既有画册分享链接回填：钉到该画册当前最新快照（把"活内容"冻结为现状）
UPDATE share_link
SET snapshot_id = (
  SELECT s.id FROM album_snapshot s
  WHERE s.album_id = share_link.scope_id
  ORDER BY s.version DESC
  LIMIT 1
)
WHERE scope = 'album' AND snapshot_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_share_snapshot ON share_link(snapshot_id);
