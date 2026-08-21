import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildPreview } from '../lib/preview';
import { ResponsePreview } from './ResponsePreview';

describe('ResponsePreview', () => {
  it('shows long text as a bounded sample instead of a full text wall', () => {
    const text = `${'x'.repeat(3000)}\nsecond-line`;
    render(<ResponsePreview value={text} />);

    expect(screen.getAllByText(/3,012 字符/).length).toBeGreaterThan(0);
    expect(screen.getByText('已截断')).toBeInTheDocument();
    expect(screen.queryByText(/^x{3000}$/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开首尾' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开首尾' }));
    expect(screen.getByText(/中间省略/)).toBeInTheDocument();
    expect(screen.getByText(/second-line/)).toBeInTheDocument();
  });

  it('breaks mixed responses into analyzable rows and nested sections', () => {
    const value = {
      id: 'chatcmpl-1',
      choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 },
    };
    render(<ResponsePreview value={value} />);

    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('"chatcmpl-1"')).toBeInTheDocument();
    expect(screen.getByText('usage')).toBeInTheDocument();
    expect(screen.queryByText('total_tokens')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /对象 1 键/ }));
    expect(screen.getByText('total_tokens')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('reports omitted items for capped arrays without dumping them', () => {
    render(<ResponsePreview value={Array.from({ length: 65 }, (_, index) => index)} />);

    expect(screen.getByText(/数组 65 项/)).toBeInTheDocument();
    expect(screen.getByText(/已省略 5 项/)).toBeInTheDocument();
    expect(screen.getByText('[0]')).toBeInTheDocument();
  });

  it('renders a prepared digest node as-is and shows an empty state for null', () => {
    const { rerender } = render(<ResponsePreview value={buildPreview({ ok: true })} />);
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('true')).toBeInTheDocument();

    rerender(<ResponsePreview value={null} />);
    expect(screen.getByText('暂无响应内容。')).toBeInTheDocument();
  });

  it('tolerates digest children flattened by redaction', () => {
    const mangled: unknown = {
      kind: 'object', length: 1, shown: 1,
      entries: [{ key: 'deep', node: '[TRUNCATED: depth limit]' }],
    };
    render(<ResponsePreview value={mangled} />);
    expect(screen.getByText('deep')).toBeInTheDocument();
    expect(screen.getByText('"[TRUNCATED: depth limit]"')).toBeInTheDocument();
  });
});
