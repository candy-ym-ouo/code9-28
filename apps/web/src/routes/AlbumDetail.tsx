import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { AlbumGapDto } from '@flil/shared';
import { useAlbum, useAlbumActions } from '../api/hooks.js';
import { authedImageUrl } from '../api/client.js';
import { useSession } from '../stores/session.js';

export default function AlbumDetail() {
  const { id } = useParams<{ id: string }>();
  const album = useAlbum(id);
  const actions = useAlbumActions();
  const tz = useSession((s) => s.libraryTz);
  const [publishing, setPublishing] = useState(false);
  const [share, setShare] = useState(true);
  const [fuzzLevel, setFuzzLevel] = useState('g500');
  const [days, setDays] = useState(7);
  const [password, setPassword] = useState('');
  const [published, setPublished] = useState<{ version: number; token: string | null } | null>(null);

  const item = album.data?.item;

  async function doPublish() {
    if (!id) return;
    try {
      const res = await actions.publish.mutateAsync({
        id,
        createShare: share,
        fuzzLevel,
        expiresInDays: days,
        password: password || null,
      });
      setPublished({ version: res.version, token: res.shareToken });
      setPublishing(false);
      message.success(`已发布 v${res.version}（快照不可变）`);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  if (!item) return <Card loading />;

  const gaps = album.data?.gaps ?? [];
  const requiredOpen = gaps.filter((g) => g.isRequired && g.status === 'open');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            {item.title}
            <Tag color={item.openRequiredGaps ? 'orange' : 'green'}>
              {item.openRequiredGaps ? `必需缺口 ${item.openRequiredGaps}` : '无必需缺口'}
            </Tag>
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              loading={actions.autoMatch.isPending}
              onClick={async () => {
                const res = await actions.autoMatch.mutateAsync(item.id);
                message.success(`按规则补了 ${res.added} 张（扫描了 ${res.scanned} 张候选）`);
              }}
            >
              按规则自动补卡
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={requiredOpen.length > 0}
              onClick={() => setPublishing(true)}
            >
              发布
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">{item.themeNote ?? '（未填主题说明）'}</Typography.Paragraph>
        {requiredOpen.length ? (
          <Alert
            type="warning"
            showIcon
            message={`还有 ${requiredOpen.length} 条必需缺口，发布会被拒绝`}
            description="逐条按下面的一键动作去补：补卡、补时段，或直接放宽画册规则。可选缺口可以豁免，但必须填原因。"
          />
        ) : (
          <Alert type="success" showIcon message="必需缺口已全部闭合，可以发布" />
        )}
      </Card>

      <Card title="缺口清单（每条都能一键跳过去）">
        <Table<AlbumGapDto>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={gaps}
          columns={[
            {
              title: '类型',
              width: 90,
              render: (_, g) => (
                <Tag>
                  {g.kind === 'tag'
                    ? '标签'
                    : g.kind === 'anchor'
                      ? '时段'
                      : g.kind === 'weather'
                        ? '天气'
                        : g.kind === 'result'
                          ? '成片'
                          : '数量'}
                </Tag>
              ),
            },
            {
              title: '要求',
              render: (_, g) => JSON.stringify(g.requirement),
            },
            {
              title: '进度',
              width: 110,
              render: (_, g) => `${g.currentCount} / ${g.requiredCount}`,
            },
            {
              title: '必需',
              width: 80,
              render: (_, g) => (g.isRequired ? <Tag color="red">必需</Tag> : <Tag>可选</Tag>),
            },
            {
              title: '状态',
              width: 90,
              render: (_, g) => (
                <Tag color={g.status === 'filled' ? 'green' : g.status === 'waived' ? 'default' : 'orange'}>
                  {g.status === 'filled' ? '已闭合' : g.status === 'waived' ? '已豁免' : '待补'}
                </Tag>
              ),
            },
            {
              title: '操作',
              render: (_, g) => (
                <Space>
                  <Link to={g.actionHref}>
                    <Button size="small">{g.actionLabel}</Button>
                  </Link>
                  {!g.isRequired && g.status === 'open' ? (
                    <Button
                      size="small"
                      onClick={() => {
                        Modal.confirm({
                          title: '豁免这条可选缺口',
                          content: (
                            <Input
                              placeholder="必填：为什么这一版可以不要它"
                              onChange={(e) => setPassword(e.target.value)}
                            />
                          ),
                          onOk: async () => {
                            await actions.waiveGap.mutateAsync({ id: item.id, gapId: g.id, reason: password || '暂不需要' });
                            message.success('已豁免');
                          },
                        });
                      }}
                    >
                      豁免
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title={`已入册 ${album.data?.items.length ?? 0} 张`}>
        {(album.data?.items ?? []).length === 0 ? (
          <Empty description="还没有入册的卡片" />
        ) : (
          <Row gutter={[12, 12]}>
            {album.data!.items.map((i) => (
              <Col xs={12} md={8} xl={6} key={i.id}>
                <Card
                  size="small"
                  cover={
                    i.assets[0] ? (
                      <img
                        src={authedImageUrl(i.assets[0].thumbUrl)}
                        alt={i.title}
                        style={{ height: 130, objectFit: 'cover' }}
                      />
                    ) : undefined
                  }
                  actions={[
                    <a
                      key="remove"
                      onClick={async () => {
                        await actions.removeItem.mutateAsync({ id: item.id, inspirationId: i.id });
                        message.success('已移出画册');
                      }}
                    >
                      移出
                    </a>,
                  ]}
                >
                  <Card.Meta title={<Link to={`/inspirations/${i.id}`}>{i.title}</Link>} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {i.spot?.fuzz.label ?? '机位未定'}
                  </Typography.Text>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      <Modal open={publishing} title="发布画册" onCancel={() => setPublishing(false)} onOk={doPublish} okText="发布">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="发布 = 生成一份不可变快照，之后原卡片再改也不会篡改已发布版本。"
          />
          <Space>
            <Typography.Text type="secondary">同时创建分享链接</Typography.Text>
            <Switch checked={share} onChange={setShare} />
          </Space>
          {share ? (
            <>
              <Space>
                <Typography.Text type="secondary">地点模糊级别</Typography.Text>
                <Select
                  value={fuzzLevel}
                  onChange={setFuzzLevel}
                  style={{ width: 180 }}
                  options={[
                    { value: 'g500', label: '约 500m（默认）' },
                    { value: 'g1k', label: '约 1km' },
                    { value: 'neighborhood', label: '街区' },
                    { value: 'district', label: '行政区' },
                  ]}
                />
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                即使这里传"精确坐标"也会被服务端强制降级为 500m —— 这是安全底线，不可关闭。
              </Typography.Text>
              <Space>
                <Typography.Text type="secondary">有效期（天）</Typography.Text>
                <Input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 100 }} />
              </Space>
              <Input.Password placeholder="访问密码（可选）" value={password} onChange={(e) => setPassword(e.target.value)} />
            </>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前时区 {tz}；分享页会写明"内容随时可能失效"。
          </Typography.Text>
        </Space>
      </Modal>

      {published ? (
        <Alert
          type="success"
          showIcon
          message={`已发布 v${published.version}`}
          description={
            <Space direction="vertical">
              {published.token ? (
                <Typography.Text copyable={{ text: `${window.location.origin}/share/${published.token}` }}>
                  分享链接：{window.location.origin}/share/{published.token}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">未创建分享链接</Typography.Text>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                本次分享链接已钉住 v{published.version}；之后再增删条目不会改变它，只有重新发布才会生成新版本与新链接。
                在「设置 → 分享审计」里可以随时撤销，撤销后旧链接立即失效。
              </Typography.Text>
            </Space>
          }
        />
      ) : null}

      <List size="small" header={<strong>推荐候选（为什么推荐这张也一并给出）</strong>} dataSource={[]} />
    </Space>
  );
}
