import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { get, patch, post } from '../api/client.js';
import { useReminders, useRevokeShare, useShareLinks, useTags } from '../api/hooks.js';
import { FUZZ_LABEL, fmtDateTime } from '../lib/format.js';
import { useSession } from '../stores/session.js';

export default function Settings() {
  const qc = useQueryClient();
  const tz = useSession((s) => s.libraryTz);
  const { data: tags, refetch: refetchTags } = useTags();
  const links = useShareLinks();
  const revoke = useRevokeShare();
  const reminders = useReminders();
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [form] = Form.useForm();
  const [newTag, setNewTag] = useState({ domain: 'light', name: '' });

  async function saveLibrary() {
    const values = await form.validateFields();
    const res = await patch<{ downgraded?: boolean }>('/library', values);
    message.success(
      res.downgraded ? '已保存（库级默认不允许精确级别，已自动降级为 500m）' : '已保存',
    );
  }

  async function runHealth() {
    const res = await get<Record<string, unknown>>('/health');
    const assets = await get<Record<string, unknown>>('/health/verify-assets');
    setHealth({ ...res, assets });
  }

  return (
    <Tabs
      items={[
        {
          key: 'library',
          label: '库设置',
          children: (
            <Card title="库与隐私默认值">
              <Form
                form={form}
                layout="vertical"
                initialValues={{ defaultFuzzLevel: 'g500' }}
                style={{ maxWidth: 520 }}
              >
                <Form.Item label="库名称" name="name">
                  <Input placeholder="不改可留空" />
                </Form.Item>
                <Form.Item label="时区" name="tz">
                  <Input placeholder="Asia/Shanghai" />
                </Form.Item>
                <Form.Item
                  label="对外默认模糊级别"
                  name="defaultFuzzLevel"
                  extra="这是协作者与分享页看到的默认精度；精确级别不允许设为默认值。"
                >
                  <Select
                    options={[
                      { value: 'g500', label: FUZZ_LABEL.g500 },
                      { value: 'g1k', label: FUZZ_LABEL.g1k },
                      { value: 'neighborhood', label: FUZZ_LABEL.neighborhood },
                      { value: 'district', label: FUZZ_LABEL.district },
                    ]}
                  />
                </Form.Item>
                <Button type="primary" onClick={saveLibrary}>
                  保存
                </Button>
              </Form>
            </Card>
          ),
        },
        {
          key: 'tags',
          label: '标签字典',
          children: (
            <Card
              title="四域标签（内置标签可停用，不可改名）"
              extra={
                <Space>
                  <Select
                    value={newTag.domain}
                    onChange={(v) => setNewTag((t) => ({ ...t, domain: v }))}
                    style={{ width: 130 }}
                    options={[
                      { value: 'light', label: '光线' },
                      { value: 'scene', label: '建筑场景' },
                      { value: 'color', label: '色彩' },
                      { value: 'composition', label: '构图' },
                    ]}
                  />
                  <Input
                    placeholder="新标签名"
                    value={newTag.name}
                    onChange={(e) => setNewTag((t) => ({ ...t, name: e.target.value }))}
                    style={{ width: 180 }}
                  />
                  <Button
                    onClick={async () => {
                      if (!newTag.name.trim()) return;
                      try {
                        await post('/tags', { domain: newTag.domain, name: newTag.name.trim() });
                        message.success('已新增标签');
                        setNewTag((t) => ({ ...t, name: '' }));
                        await refetchTags();
                        await qc.invalidateQueries({ queryKey: ['meta'] });
                      } catch (err) {
                        message.error((err as Error).message);
                      }
                    }}
                  >
                    新增
                  </Button>
                </Space>
              }
            >
              <Table
                size="small"
                rowKey="id"
                pagination={{ pageSize: 12 }}
                dataSource={(tags?.items ?? []).flatMap((g) =>
                  (g.children ?? []).map((c) => ({ ...c, groupName: g.name })),
                )}
                columns={[
                  { title: '域', dataIndex: 'domain', width: 100 },
                  { title: '分组', dataIndex: 'groupName', width: 120 },
                  { title: '名称', dataIndex: 'name' },
                  { title: '使用次数', dataIndex: 'usageCount', width: 100 },
                  {
                    title: '内置',
                    dataIndex: 'isBuiltin',
                    width: 80,
                    render: (v: boolean) => (v ? <Tag>内置</Tag> : <Tag color="blue">自定义</Tag>),
                  },
                ]}
              />
            </Card>
          ),
        },
        {
          key: 'share',
          label: '分享审计',
          children: (
            <Card
              title="我对外开过哪些口子"
              extra={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  撤销即时生效，旧链接下一次请求即 401
                </Typography.Text>
              }
            >
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={links.data?.items ?? []}
                columns={[
                  { title: '范围', dataIndex: 'scope', width: 100 },
                  {
                    title: '级别',
                    dataIndex: 'fuzzLevel',
                    render: (v: string) => <Tag color="green">{FUZZ_LABEL[v as keyof typeof FUZZ_LABEL] ?? v}</Tag>,
                  },
                  {
                    title: '冻结版本',
                    dataIndex: 'snapshotVersion',
                    width: 100,
                    render: (v, r) =>
                      r.scope === 'album' ? (v ? <Tag color="blue">v{v}</Tag> : <Tag>未发布</Tag>) : '—',
                  },
                  { title: '状态', dataIndex: 'status', width: 90 },
                  { title: '访问次数', dataIndex: 'viewCount', width: 90 },
                  {
                    title: '过期时间',
                    render: (_, r) => fmtDateTime(r.expiresAt, tz),
                  },
                  {
                    title: '操作',
                    render: (_, r) =>
                      r.status === 'active' ? (
                        <Button
                          size="small"
                          danger
                          onClick={async () => {
                            await revoke.mutateAsync(r.id);
                            message.success('已撤销');
                          }}
                        >
                          撤销
                        </Button>
                      ) : (
                        <Typography.Text type="secondary">—</Typography.Text>
                      ),
                  },
                ]}
              />
            </Card>
          ),
        },
        {
          key: 'system',
          label: '系统与备份',
          children: (
            <Card
              title="健康检查与备份"
              extra={
                <Space>
                  <Button size="small" onClick={runHealth}>
                    运行健康检查
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    onClick={async () => {
                      const res = await post<{ name: string }>('/backup', {});
                      message.success(`备份完成：${res.name}`);
                    }}
                  >
                    立即备份
                  </Button>
                </Space>
              }
            >
              {health ? (
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="数据库">{String(health.db)}</Descriptions.Item>
                  <Descriptions.Item label="目录">{JSON.stringify(health.dirs)}</Descriptions.Item>
                  <Descriptions.Item label="天气源">
                    {String(health.weatherProvider)}
                    {health.weatherDegraded ? '（已降级）' : ''}
                  </Descriptions.Item>
                  <Descriptions.Item label="图片一致性">
                    {JSON.stringify(health.assets)}
                  </Descriptions.Item>
                </Descriptions>
              ) : (
                <Typography.Text type="secondary">点右上角运行一次检查。</Typography.Text>
              )}

              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                message="备份内容包含数据库与图片目录；还原前系统会自动再备份一份当前状态（可回滚）。"
              />
            </Card>
          ),
        },
        {
          key: 'reminders',
          label: '提醒历史',
          children: (
            <Card title="提醒记录（每条都有终态，不会永远挂着）">
              <Table
                size="small"
                rowKey="id"
                pagination={{ pageSize: 15 }}
                dataSource={reminders.data?.items ?? []}
                columns={[
                  { title: '规则', dataIndex: 'ruleCode', width: 80 },
                  { title: '标题', dataIndex: 'title' },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 110,
                    render: (v: string) => (
                      <Tag color={v === 'done' ? 'green' : v === 'expired' ? 'default' : v === 'dismissed' ? 'orange' : 'blue'}>
                        {v}
                      </Tag>
                    ),
                  },
                  { title: '到期', render: (_, r) => fmtDateTime(r.dueAt, tz) },
                  {
                    title: '过期时间',
                    render: (_, r) => (r.expireAt ? fmtDateTime(r.expireAt, tz) : '—'),
                  },
                ]}
              />
            </Card>
          ),
        },
      ]}
    />
  );
}
