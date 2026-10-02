import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Descriptions, Input, Row, Space, Tag, Typography, message } from 'antd';
import { get } from '../api/client.js';
import { fmtDateTime } from '../lib/format.js';

interface SharePayload {
  scope: 'album' | 'inspiration';
  fuzzLevel: string;
  expiresAt: string;
  notice: string;
  frozen?: boolean;
  version?: number;
  snapshot?: {
    version: number;
    createdAt?: string;
    payload: { title?: string; themeNote?: string; conditionSummary?: string };
  } | null;
  items?: ShareItem[];
  item?: ShareItem;
}

interface ShareItem {
  id: string;
  title: string;
  caption?: string | null;
  tags: { id: string; name: string; domain: string }[];
  fuzz: { label: string; geohash: string } | null;
  anchor: string | null;
  assets: { id: string; url: string }[];
}

/**
 * 公开只读分享页：无需登录，但必须通过密码（若设置）。
 * 页面只展示模糊地点与脱敏图片，且每次刷新都会重新校验撤销/过期。
 */
export default function ShareView() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [data, setData] = useState<SharePayload | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(pwd?: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await get<SharePayload>(`/share/${token}${pwd ? `?password=${encodeURIComponent(pwd)}` : ''}`);
      setData(res);
    } catch (err) {
      const e = err as { code?: string; message: string };
      setError({ code: e.code ?? 'ERROR', message: e.message });
    } finally {
      setLoading(false);
    }
  }

  const items = data ? (data.items ?? (data.item ? [data.item] : [])) : [];

  return (
    <div style={{ minHeight: '100vh', background: '#f0f3f5', padding: 24 }}>
      <Card style={{ maxWidth: 1080, margin: '0 auto' }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {data?.snapshot?.payload?.title ?? data?.item?.title ?? '取景灵感分享'}
        </Typography.Title>

        {!data && !error ? (
          <Space direction="vertical" style={{ width: '100%', maxWidth: 420 }}>
            <Typography.Text type="secondary">
              这是一个只读分享链接。如果设了密码，请输入后查看。
            </Typography.Text>
            <Space>
              <Input.Password
                placeholder="访问密码（未设置可留空）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onPressEnter={() => void load(password)}
              />
              <Button type="primary" loading={loading} onClick={() => void load(password)}>
                查看
              </Button>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              分享内容随时可能失效；位置信息已按分享级别模糊化。
            </Typography.Text>
          </Space>
        ) : null}

        {error ? (
          <Alert
            type="error"
            showIcon
            message={
              error.code === 'SHARE_PASSWORD_REQUIRED'
                ? '需要访问密码'
                : error.code === 'SHARE_REVOKED'
                  ? '这份分享已被撤销'
                  : error.code === 'SHARE_EXPIRED'
                    ? '这份分享已过期'
                    : error.message
            }
            description={
              error.code === 'SHARE_PASSWORD_REQUIRED' ? (
                <Space>
                  <Input.Password
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onPressEnter={() => void load(password)}
                  />
                  <Button size="small" onClick={() => void load(password)}>
                    重试
                  </Button>
                </Space>
              ) : null
            }
          />
        ) : null}

        {data ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="地点精度">
                <Tag color="green">{data.fuzzLevel}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="有效期至">{fmtDateTime(data.expiresAt, 'Asia/Shanghai')}</Descriptions.Item>
              {data.frozen && data.version !== undefined ? (
                <Descriptions.Item label="内容版本">
                  <Tag color="blue">v{data.version}（已冻结）</Tag>
                </Descriptions.Item>
              ) : null}
            </Descriptions>

            {data.snapshot?.payload?.themeNote ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {data.snapshot.payload.themeNote}
              </Typography.Paragraph>
            ) : null}

            {data.snapshot?.payload?.conditionSummary ? (
              <Alert
                type="info"
                showIcon
                message="照着做的条件说明"
                description={data.snapshot.payload.conditionSummary}
              />
            ) : null}

            <Row gutter={[12, 12]}>
              {items.map((i) => (
                <Col xs={24} md={12} xl={8} key={i.id}>
                  <Card
                    size="small"
                    cover={
                      i.assets[0] ? (
                        <img
                          src={`/api${i.assets[0].url}`}
                          alt={i.title}
                          style={{ height: 200, objectFit: 'cover' }}
                          onError={() => message.warning('图片需要重新校验访问权限，请刷新页面')}
                        />
                      ) : undefined
                    }
                  >
                    <Typography.Text strong>{i.title}</Typography.Text>
                    {i.caption ? (
                      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                        {i.caption}
                      </Typography.Paragraph>
                    ) : null}
                    <div style={{ marginTop: 6 }}>
                      <Space wrap size={[4, 4]}>
                        {i.tags.map((t) => (
                          <Tag key={t.id}>{t.name}</Tag>
                        ))}
                      </Space>
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {i.fuzz?.label ?? '地点已隐藏'}
                      {i.anchor ? ` · 时段 ${i.anchor}` : ''}
                    </Typography.Text>
                  </Card>
                </Col>
              ))}
            </Row>

            {data.frozen ? (
              <Alert type="success" showIcon message="内容已冻结" description={data.notice} />
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {data.notice}
              </Typography.Text>
            )}
          </Space>
        ) : null}
      </Card>
    </div>
  );
}
